use std::{io, path::PathBuf, time::Duration};

use clap::{Parser, ValueEnum};
use tonic::transport::Endpoint;
use uuid::Uuid;

use crate::{CollectorConfig, enrollment::EnrollmentConfig, spool::Result};

/// Largest whole-second duration representable as UInt64 nanoseconds.
const MAX_U64_NANOSECONDS_DURATION_SECONDS: u64 = u64::MAX / 1_000_000_000;

/// Sampling, queue and export settings read once at startup.
#[derive(Parser)]
#[command(
    name = "recount-collector",
    version,
    about = "Collect Linux node and process resource metrics"
)]
pub struct Config {
    /// Export the existing queue without sampling, then exit when it is empty.
    #[arg(long)]
    pub drain: bool,
    /// Sampling interval in milliseconds.
    #[arg(long, env = "RECOUNT_COLLECTOR_INTERVAL_MS", default_value_t = 1000, value_parser = clap::value_parser!(u64).range(100..=60_000))]
    pub interval_ms: u64,
    /// Maximum bytes of queued Protobuf payloads.
    #[arg(long, env = "RECOUNT_COLLECTOR_QUEUE_MAX_BYTES", default_value_t = 64 * 1024 * 1024, value_parser = clap::value_parser!(u64).range(1024 * 1024..=1024 * 1024 * 1024))]
    pub queue_max_bytes: u64,
    /// Maximum number of queued batches.
    #[arg(long, env = "RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES", default_value_t = 1024, value_parser = clap::value_parser!(u64).range(1..=65_536))]
    pub queue_max_batches: u64,
    /// Maximum pending-batch age in seconds.
    #[arg(long, env = "RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS", default_value_t = 3600, value_parser = clap::value_parser!(u64).range(1..=MAX_U64_NANOSECONDS_DURATION_SECONDS))]
    pub queue_max_age_seconds: u64,
    /// Directory for the persistent upload queue.
    #[arg(
        long,
        env = "RECOUNT_COLLECTOR_QUEUE_DIRECTORY",
        default_value = ".state/collector-queue"
    )]
    pub queue_directory: PathBuf,
    /// OTLP/gRPC destination.
    #[arg(
        long,
        env = "OTEL_EXPORTER_OTLP_ENDPOINT",
        default_value = "http://127.0.0.1:14317"
    )]
    pub endpoint: String,
    /// Web application URL that enrolls this node and issues its access tokens.
    #[arg(long, env = "RECOUNT_COLLECTOR_ENROLLMENT_URL")]
    pub enrollment_url: Option<String>,
    /// Private file containing the project's enrollment key; needed only until the node
    /// has enrolled.
    #[arg(
        long,
        env = "RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE",
        requires = "enrollment_url"
    )]
    pub enrollment_key_file: Option<PathBuf>,
    /// Directory for the node identity: `node.json` and the private key `node.key`.
    #[arg(
        long,
        env = "RECOUNT_COLLECTOR_STATE_DIRECTORY",
        default_value = ".state/collector"
    )]
    pub state_directory: PathBuf,
    /// Enrolled host identity; defaults to the Linux machine ID.
    #[arg(long, env = "RECOUNT_COLLECTOR_HOST_ID")]
    pub host_id: Option<String>,
    /// Process namespace identity; required with restricted visibility.
    #[arg(long, env = "RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID")]
    pub process_namespace_id: Option<String>,
    /// Whether deployment has verified visibility of initial host PIDs.
    #[arg(
        long,
        env = "RECOUNT_COLLECTOR_VISIBILITY",
        value_enum,
        default_value = "restricted"
    )]
    pub visibility: Visibility,
}

/// Process visibility asserted by the deployment.
#[derive(Clone, Copy, ValueEnum)]
pub enum Visibility {
    Host,
    Restricted,
}

/// Validated transport and enrollment settings.
pub(crate) struct ExportConfig {
    pub endpoint: Endpoint,
    pub enrollment: Option<EnrollmentConfig>,
}

/// The identity a persistent queue is bound to. Token refreshes keep it; another node or
/// endpoint needs a new queue.
pub(crate) fn queue_destination(endpoint: &str, node: Option<Uuid>) -> String {
    match node {
        Some(node) => format!("{endpoint}#node={node}"),
        None => endpoint.to_owned(),
    }
}

impl Config {
    pub(crate) fn sampling(&self) -> CollectorConfig {
        CollectorConfig {
            interval: Duration::from_millis(self.interval_ms),
            host_id: self.host_id.clone(),
            namespace_id: self.process_namespace_id.clone(),
            host_visibility: matches!(self.visibility, Visibility::Host),
        }
    }

    pub(crate) fn export(&self) -> Result<ExportConfig> {
        let endpoint = Endpoint::from_shared(self.endpoint.clone())?;
        if endpoint.uri().scheme_str() != Some("http") {
            return Err(io::Error::other("OTLP export currently requires an http endpoint").into());
        }
        let enrollment = self
            .enrollment_url
            .as_deref()
            .map(|url| {
                let mut url = reqwest::Url::parse(url)
                    .ok()
                    .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                    .ok_or_else(|| io::Error::other("Invalid enrollment URL"))?;
                // Join API paths below the configured path instead of replacing its last segment.
                if !url.path().ends_with('/') {
                    url.set_path(&format!("{}/", url.path()));
                }
                Ok::<_, io::Error>(EnrollmentConfig {
                    url,
                    key_file: self.enrollment_key_file.clone(),
                    state_directory: self.state_directory.clone(),
                })
            })
            .transpose()?;
        Ok(ExportConfig {
            endpoint,
            enrollment,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_settings_and_queue_binding() {
        let config = Config::try_parse_from([
            "collector",
            "--enrollment-url",
            "https://recount.example/app",
            "--enrollment-key-file",
            "/run/secrets/enrollment-key",
        ])
        .unwrap();
        let enrollment = config.export().unwrap().enrollment.unwrap();
        assert_eq!(
            enrollment
                .url
                .join("api/collectors/enroll")
                .unwrap()
                .as_str(),
            "https://recount.example/app/api/collectors/enroll"
        );
        assert!(Config::try_parse_from(["collector", "--enrollment-key-file", "key"]).is_err());
        for url in ["ftp://recount.example", "not a url"] {
            let config = Config::try_parse_from(["collector", "--enrollment-url", url]).unwrap();
            assert!(config.export().is_err());
        }
        let node = Uuid::now_v7();
        assert_eq!(
            queue_destination("http://ingestion:4317", Some(node)),
            format!("http://ingestion:4317#node={node}")
        );
        assert_ne!(
            queue_destination("http://ingestion:4317", Some(node)),
            queue_destination("http://ingestion:4317", Some(Uuid::now_v7()))
        );
    }

    #[test]
    fn settings_enforce_sampling_and_queue_limits() {
        for args in [
            vec!["collector", "--interval-ms", "99"],
            vec!["collector", "--queue-max-batches", "0"],
            vec!["collector", "--queue-max-age-seconds", "18446744074"],
            vec!["collector", "--visibility", "unknown"],
        ] {
            assert!(Config::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn queue_age_is_finite_and_fits_uint64_nanoseconds() {
        let max = MAX_U64_NANOSECONDS_DURATION_SECONDS;
        assert!(u64::try_from(Duration::from_secs(max).as_nanos()).is_ok());
        assert!(u64::try_from(Duration::from_secs(max + 1).as_nanos()).is_err());
        for seconds in [1, max] {
            let config = Config::try_parse_from([
                "collector",
                "--queue-max-age-seconds",
                &seconds.to_string(),
            ])
            .unwrap();
            assert_eq!(config.queue_max_age_seconds, seconds);
        }
        for seconds in [0, max + 1] {
            assert!(
                Config::try_parse_from([
                    "collector",
                    "--queue-max-age-seconds",
                    &seconds.to_string(),
                ])
                .is_err()
            );
        }
        assert!(
            Config::try_parse_from(["collector", "--queue-max-age-seconds", "Infinity"]).is_err()
        );
    }

    #[test]
    fn host_visibility_reaches_the_sampler_and_https_is_not_silently_downgraded() {
        let config = Config::try_parse_from([
            "collector",
            "--host-id",
            "node1",
            "--visibility",
            "host",
            "--endpoint",
            "https://example.invalid",
        ])
        .unwrap();
        assert!(config.sampling().host_visibility);
        assert_eq!(config.sampling().host_id.as_deref(), Some("node1"));
        assert!(config.export().is_err());
    }
}
