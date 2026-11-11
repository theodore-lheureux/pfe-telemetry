use clap::{CommandFactory, Parser, Subcommand, error::ErrorKind};
use recount_telemetry_schema::{NORMALIZED_TOPIC, NORMALIZER_GROUP, RAW_TOPIC};
use recount_telemetry_validation::{
    cli::{LimitArgs, nonblank},
    transport::{self, MAX_BROKER_BYTES, NORMALIZED_BROKER_BYTES, RAW_BROKER_BYTES},
    validate::Limits,
};
use std::time::Duration;

#[derive(Debug, Parser)]
#[command(
    name = "recount-normalizer",
    version,
    about = "Normalize retained raw metrics"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[arg(long, env = "RECOUNT_KAFKA_BOOTSTRAP", default_value = "kafka:9092", value_parser = nonblank)]
    kafka_bootstrap: String,
    #[arg(long, env = "RECOUNT_RAW_TOPIC", default_value = RAW_TOPIC, value_parser = nonblank)]
    raw_topic: String,
    #[arg(long, env = "RECOUNT_NORMALIZED_TOPIC", default_value = NORMALIZED_TOPIC, value_parser = nonblank)]
    normalized_topic: String,
    #[arg(long, env = "RECOUNT_NORMALIZER_GROUP", default_value = NORMALIZER_GROUP, value_parser = nonblank)]
    group: String,
    #[arg(long, env = "RECOUNT_RAW_PARTITIONS", default_value_t = 3, value_parser = clap::value_parser!(u32).range(1..=4096))]
    raw_partitions: u32,
    #[arg(long, env = "RECOUNT_NORMALIZED_PARTITIONS", default_value_t = 3, value_parser = clap::value_parser!(u32).range(1..=4096))]
    normalized_partitions: u32,
    #[arg(long, env = "RECOUNT_NORMALIZER_MAX_ACTIVE", default_value_t = 2, value_parser = clap::value_parser!(u32).range(1..=8))]
    max_active: u32,
    /// Native producer retry backoff in milliseconds, within the delivery deadline.
    #[arg(long, env = "RECOUNT_NORMALIZER_RETRY_MS", default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=60_000))]
    retry_ms: u32,
    /// Publication delivery timeout in milliseconds.
    #[arg(long, env = "RECOUNT_NORMALIZER_DELIVERY_MS", default_value_t = 10000, value_parser = clap::value_parser!(u32).range(1..=60_000))]
    delivery_ms: u32,
    /// Shutdown drain deadline in milliseconds.
    #[arg(long, env = "RECOUNT_NORMALIZER_SHUTDOWN_MS", default_value_t = 15000, value_parser = clap::value_parser!(u32).range(1..=120_000))]
    shutdown_ms: u32,
    #[command(flatten)]
    limits: LimitArgs,
    #[arg(long, env = "RECOUNT_RAW_BROKER_MAX_BYTES", default_value_t = RAW_BROKER_BYTES, value_parser = clap::value_parser!(u32).range(1000..=MAX_BROKER_BYTES as i64))]
    raw_broker_max_bytes: u32,
    #[arg(long, env = "RECOUNT_NORMALIZED_BROKER_MAX_BYTES", default_value_t = NORMALIZED_BROKER_BYTES, value_parser = clap::value_parser!(u32).range(1000..=MAX_BROKER_BYTES as i64))]
    normalized_broker_max_bytes: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Subcommand)]
pub enum Command {
    /// Check configuration declarations without connecting to Kafka.
    Validate,
    /// Seed retained earliest offsets for a genuinely new group; never run on restart.
    Bootstrap,
}

fn invalid(reason: &'static str) -> clap::Error {
    Cli::command().error(ErrorKind::ValueValidation, reason)
}

impl Cli {
    pub fn into_config(self) -> Result<Config, clap::Error> {
        let config = Config {
            limits: self
                .limits
                .limits()
                .map_err(|_| invalid("incoherent validation limits"))?,
            raw_broker_max_bytes: self.raw_broker_max_bytes as usize,
            normalized_broker_max_bytes: self.normalized_broker_max_bytes as usize,
            bootstrap: self.kafka_bootstrap,
            raw_topic: self.raw_topic,
            normalized_topic: self.normalized_topic,
            group: self.group,
            raw_partitions: self.raw_partitions,
            normalized_partitions: self.normalized_partitions,
            max_active: self.max_active as usize,
            retry: Duration::from_millis(self.retry_ms.into()),
            delivery: Duration::from_millis(self.delivery_ms.into()),
            shutdown: Duration::from_millis(self.shutdown_ms.into()),
        };
        if config.raw_topic == config.normalized_topic {
            return Err(invalid("raw and normalized topics must differ"));
        }
        config.validate_transport().map_err(invalid)?;
        Ok(config)
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub limits: Limits,
    pub raw_broker_max_bytes: usize,
    pub normalized_broker_max_bytes: usize,
    pub bootstrap: String,
    pub raw_topic: String,
    pub normalized_topic: String,
    pub group: String,
    pub raw_partitions: u32,
    pub normalized_partitions: u32,
    pub max_active: usize,
    pub retry: Duration,
    pub delivery: Duration,
    pub shutdown: Duration,
}

impl Config {
    /// Read environment settings without consuming the embedding process's arguments.
    pub fn from_env() -> Result<Self, clap::Error> {
        Cli::try_parse_from(["recount-normalizer"])?.into_config()
    }

    pub fn validate_transport(&self) -> Result<(), &'static str> {
        transport::body_fits(self.limits.decoded_bytes, self.raw_broker_max_bytes)?;
        transport::body_fits(
            self.limits.normalized_record_bytes,
            self.normalized_broker_max_bytes,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::FromArgMatches;
    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;
    use std::{ffi::OsStr, process};

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let matches = Cli::command()
            .mut_args(|arg| arg.env(None::<&str>))
            .try_get_matches_from(args)?;
        Cli::from_arg_matches(&matches)
    }

    #[test]
    fn defaults_and_explicit_bootstrap_preserve_normal_operation() {
        let cli = parse(&["normalizer"]).unwrap();
        assert_eq!(cli.command, None);
        let config = cli.into_config().unwrap();
        assert_eq!(config.bootstrap, "kafka:9092");
        assert_eq!(config.raw_topic, RAW_TOPIC);
        assert_eq!(config.normalized_topic, NORMALIZED_TOPIC);
        assert_eq!(config.group, NORMALIZER_GROUP);
        assert_eq!(
            (config.raw_partitions, config.normalized_partitions),
            (3, 3)
        );
        assert_eq!(config.max_active, 2);
        assert_eq!(config.retry, Duration::from_millis(1000));
        assert_eq!(config.delivery, Duration::from_millis(10000));
        assert_eq!(config.shutdown, Duration::from_millis(15000));
        assert_eq!(config.raw_broker_max_bytes, 6291456);
        assert_eq!(config.normalized_broker_max_bytes, 2097152);
        assert_eq!(config.limits.decoded_bytes, 4194304);
        assert_eq!(config.limits.points, 16384);
        assert_eq!(config.limits.expanded_items, 262144);
        assert_eq!(config.limits.distinct_authorities, 256);
        assert_eq!(config.limits.attributes_per_set, 128);
        assert_eq!(config.limits.normalized_record_bytes, 1048576);
        assert_eq!(config.limits.normalized_batch_bytes, 16777216);
        assert_eq!(
            parse(&["normalizer", "bootstrap"]).unwrap().command,
            Some(Command::Bootstrap)
        );
        assert!(parse(&["normalizer", "run"]).is_err());
        assert!(parse(&["normalizer", "bootstrap", "bootstrap"]).is_err());
        for flag in ["--help", "--version"] {
            let error = parse(&["normalizer", flag]).unwrap_err();
            assert!(!error.use_stderr());
        }
    }

    #[test]
    fn scalar_bounds_reject_zero_overflow_and_nonintegers() {
        for (flag, max) in [
            ("--raw-partitions", 4096),
            ("--normalized-partitions", 4096),
            ("--max-active", 8),
            ("--retry-ms", 60_000),
            ("--delivery-ms", 60_000),
            ("--shutdown-ms", 120_000),
            ("--raw-broker-max-bytes", MAX_BROKER_BYTES as i32),
            ("--normalized-broker-max-bytes", MAX_BROKER_BYTES as i32),
        ] {
            for value in [
                "0".to_owned(),
                (i64::from(max) + 1).to_string(),
                "4294967296".to_owned(),
                "1.5".to_owned(),
                " ".to_owned(),
                "-1".to_owned(),
            ] {
                assert!(
                    parse(&["normalizer", flag, &value]).is_err(),
                    "{flag}={value}"
                );
            }
            let min = if flag.ends_with("broker-max-bytes") {
                "1000"
            } else {
                "1"
            };
            for value in [min.to_owned(), max.to_string()] {
                assert!(
                    parse(&["normalizer", flag, &value]).is_ok(),
                    "{flag}={value}"
                );
            }
        }
        for flag in [
            "--kafka-bootstrap",
            "--raw-topic",
            "--normalized-topic",
            "--group",
        ] {
            assert!(parse(&["normalizer", flag, " \t"]).is_err());
        }
    }

    #[test]
    fn cross_field_limits_keep_exact_transport_headroom() {
        for args in [
            vec![
                "normalizer",
                "--raw-topic",
                "same",
                "--normalized-topic",
                "same",
            ],
            vec!["normalizer", "--normalized-max-output-bytes", "1048575"],
            vec!["normalizer", "--raw-broker-max-bytes", "4259839"],
            vec!["normalizer", "--normalized-broker-max-bytes", "1114111"],
        ] {
            assert!(parse(&args).unwrap().into_config().is_err());
        }
        let mut config = parse(&[
            "normalizer",
            "--raw-broker-max-bytes",
            "4259840",
            "--normalized-broker-max-bytes",
            "1114112",
            "--normalized-max-output-bytes",
            "1048576",
        ])
        .unwrap()
        .into_config()
        .unwrap();
        config.limits.decoded_bytes = usize::MAX;
        assert!(config.validate_transport().is_err());
        config.limits.decoded_bytes = 1;
        config.limits.normalized_record_bytes = usize::MAX;
        assert!(config.validate_transport().is_err());
    }

    fn probe(env: &[(&str, &OsStr)]) {
        let output = process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "config::tests::environment_probe", "--nocapture"])
            .env_clear()
            .envs(env.iter().copied())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn environment_is_validated_without_mutating_the_test_process() {
        probe(&[
            ("RECOUNT_CONFIG_PROBE", OsStr::new("valid")),
            ("RECOUNT_NORMALIZER_GROUP", OsStr::new(" env-group ")),
            ("RECOUNT_NORMALIZER_RETRY_MS", OsStr::new("321")),
        ]);
        for (name, value) in [
            ("RECOUNT_KAFKA_BOOTSTRAP", ""),
            ("RECOUNT_RAW_TOPIC", " \t"),
            ("RECOUNT_MAX_POINTS", "0"),
            ("RECOUNT_NORMALIZER_MAX_ACTIVE", "9"),
            ("RECOUNT_RAW_BROKER_MAX_BYTES", "4194304"),
            ("RECOUNT_NORMALIZED_MAX_OUTPUT_BYTES", "1"),
        ] {
            probe(&[
                ("RECOUNT_CONFIG_PROBE", OsStr::new("invalid")),
                (name, OsStr::new(value)),
            ]);
        }
        #[cfg(unix)]
        {
            for name in ["RECOUNT_NORMALIZER_GROUP", "RECOUNT_MAX_POINTS"] {
                probe(&[
                    ("RECOUNT_CONFIG_PROBE", OsStr::new("invalid")),
                    (name, OsStr::from_bytes(b"\xff")),
                ]);
            }
        }
    }

    #[test]
    fn environment_probe() {
        match std::env::var("RECOUNT_CONFIG_PROBE").as_deref() {
            Ok("valid") => {
                let config = Config::from_env().unwrap();
                assert_eq!(config.group, " env-group ");
                assert_eq!(config.retry, Duration::from_millis(321));
                let cli = Cli::try_parse_from(["normalizer", "--group", "cli-group"]).unwrap();
                assert_eq!(cli.into_config().unwrap().group, "cli-group");
            }
            Ok("invalid") => assert!(Config::from_env().is_err()),
            _ => {}
        }
    }
}
