use std::{fs, io, path::PathBuf, time::Duration};

use clap::{Parser, ValueEnum};
use sha2::{Digest, Sha256};
use tonic::{
    metadata::{Ascii, MetadataValue},
    transport::Endpoint,
};

use crate::{CollectorConfig, spool::Result};

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
    /// Private file containing the source bearer token.
    #[arg(
        long,
        env = "RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE",
        hide_env_values = true
    )]
    pub source_token_file: Option<PathBuf>,
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

/// Validated transport settings and the identity bound to queued uploads.
pub(crate) struct ExportConfig {
    pub endpoint: Endpoint,
    pub authorization: Option<MetadataValue<Ascii>>,
    pub queue_destination: String,
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
        let token = self
            .source_token_file
            .as_ref()
            .map(|path| fs::read_to_string(path).map(|value| value.trim().to_owned()))
            .transpose()?;
        let authorization = token
            .as_ref()
            .map(|token| {
                if !(32..=512).contains(&token.len())
                    || !token.bytes().all(|b| b.is_ascii_graphic())
                {
                    return Err(io::Error::other("Invalid source token file"));
                }
                let mut value = format!("Bearer {token}")
                    .parse::<MetadataValue<Ascii>>()
                    .map_err(|_| io::Error::other("Invalid source token file"))?;
                value.set_sensitive(true);
                Ok(value)
            })
            .transpose()?;
        let queue_destination = match token {
            Some(token) => {
                let digest = Sha256::digest(token.as_bytes())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                format!("{}#credential={digest}", self.endpoint)
            }
            None => self.endpoint.clone(),
        };
        Ok(ExportConfig {
            endpoint,
            authorization,
            queue_destination,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_credential_file_is_sensitive_and_rotation_changes_queue_binding() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let path =
            std::env::temp_dir().join(format!("recount-token-test-{}", uuid::Uuid::now_v7()));
        let token = "recount_019a4790-d1da-7000-8000-000000000001_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        writeln!(file, "{token}").unwrap();
        let config =
            Config::try_parse_from(["collector", "--source-token-file", path.to_str().unwrap()])
                .unwrap();
        let first = config.export().unwrap();
        let authorization = first.authorization.unwrap();
        assert!(authorization.is_sensitive());
        assert_eq!(authorization.to_str().unwrap(), format!("Bearer {token}"));
        assert!(!first.queue_destination.contains(token));
        fs::write(&path, token.replace('A', "B")).unwrap();
        let rotated = config.export().unwrap();
        assert_ne!(first.queue_destination, rotated.queue_destination);
        fs::remove_file(path).unwrap();
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
