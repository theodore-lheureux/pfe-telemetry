use clap::{CommandFactory, Parser, Subcommand, builder::TypedValueParser, error::ErrorKind};
use recount_telemetry_validation::{
    cli::{LimitArgs, nonblank},
    transport::{self, MAX_BROKER_BYTES, RAW_BROKER_BYTES},
    validate::Limits,
};
use std::net::SocketAddr;

#[derive(Parser)]
#[command(
    name = "recount-ingestion-api",
    version,
    subcommand_negates_reqs = true
)]
pub struct Config {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[arg(long, env = "RECOUNT_INGESTION_ADDR", default_value = "0.0.0.0:4317")]
    pub addr: SocketAddr,
    #[arg(
        long,
        env = "RECOUNT_INGESTION_DATABASE_URL",
        hide_env_values = true,
        required = true
    )]
    pub database_url: Option<String>,
    /// Base64url Ed25519 public keys trusted to sign collector access tokens, comma-separated.
    /// List the previous and next key together while rotating the web application's key.
    #[arg(
        long,
        env = "RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS",
        value_delimiter = ',',
        required = true
    )]
    pub collector_public_keys: Vec<String>,
    #[arg(long, env = "RECOUNT_KAFKA_BOOTSTRAP", default_value = "kafka:9092", value_parser = nonblank)]
    pub kafka_bootstrap: String,
    #[arg(long, env = "RECOUNT_RAW_TOPIC", default_value = recount_telemetry_schema::RAW_TOPIC, value_parser = nonblank)]
    pub raw_topic: String,
    #[arg(long, env = "RECOUNT_LIVE_TOPIC", default_value = "recount.metrics.live", value_parser = nonblank)]
    pub live_topic: String,
    #[arg(long, env = "RECOUNT_LIVE_PARTITIONS", default_value_t = 8, value_parser = clap::value_parser!(u32).range(1..=256))]
    pub live_partitions: u32,
    #[arg(long, env = "RECOUNT_RAW_PARTITIONS", default_value_t = 3, value_parser = clap::value_parser!(i32).range(1..))]
    pub raw_partitions: i32,
    #[arg(long, env = "RECOUNT_RAW_BROKER_MAX_BYTES", default_value_t = RAW_BROKER_BYTES as usize, value_parser = clap::value_parser!(u32).range(1000..=MAX_BROKER_BYTES as i64).map(|v| v as usize))]
    pub raw_broker_max_bytes: usize,
    #[command(flatten)]
    pub validation: LimitArgs,
    #[arg(long, env = "RECOUNT_INGESTION_MAX_IN_FLIGHT", default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..))]
    pub max_in_flight: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Subcommand)]
pub enum Command {
    /// Check declarations without credentials, backend clients or listening sockets.
    Validate,
}

impl Config {
    pub fn limits(&self) -> Result<Limits, clap::Error> {
        let invalid = |reason| Self::command().error(ErrorKind::ValueValidation, reason);
        let limits = self
            .validation
            .limits()
            .map_err(|_| invalid("incoherent validation limits"))?;
        if self.raw_topic == self.live_topic {
            return Err(invalid("raw and Live topics must differ"));
        }
        transport::body_fits(limits.decoded_bytes, self.raw_broker_max_bytes).map_err(invalid)?;
        if self
            .database_url
            .as_ref()
            .is_some_and(|url| url.trim().is_empty())
        {
            return Err(invalid("nonempty ingestion database URL required"));
        }
        Ok(limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::FromArgMatches;

    fn parse(args: &[&str]) -> Result<Config, clap::Error> {
        let matches = Config::command()
            .mut_args(|arg| arg.env(None::<&str>))
            .try_get_matches_from(args)?;
        Config::from_arg_matches(&matches)
    }

    #[test]
    fn defaults_validate_offline_but_service_credentials_remain_required() {
        assert!(parse(&["ingestion"]).is_err());
        let config = parse(&["ingestion", "validate"]).unwrap();
        assert_eq!(config.limits().unwrap(), Limits::default());
        assert!(config.database_url.is_none());
        assert_eq!(config.raw_broker_max_bytes, RAW_BROKER_BYTES as usize);
        assert!(parse(&["ingestion", "--database-url", "synthetic"]).is_err());
        let service = parse(&[
            "ingestion",
            "--database-url",
            "synthetic",
            "--collector-public-keys",
            "first,second",
        ])
        .unwrap();
        assert_eq!(service.collector_public_keys, ["first", "second"]);
        assert!(
            parse(&["ingestion", "--database-url", " ", "validate"])
                .unwrap()
                .limits()
                .is_err()
        );
    }

    #[test]
    fn custom_headroom_and_invalid_declarations_use_startup_validator() {
        let valid = parse(&[
            "ingestion",
            "--max-request-bytes",
            "7000000",
            "--raw-broker-max-bytes",
            "7065536",
            "validate",
        ])
        .unwrap();
        assert_eq!(valid.limits().unwrap().decoded_bytes, 7_000_000);
        for args in [
            vec!["ingestion", "--raw-broker-max-bytes", "4259839", "validate"],
            vec![
                "ingestion",
                "--normalized-max-output-bytes",
                "1048575",
                "validate",
            ],
        ] {
            assert!(parse(&args).unwrap().limits().is_err());
        }
        for (flag, value) in [
            ("--kafka-bootstrap", " "),
            ("--raw-topic", ""),
            ("--max-points", "0"),
            ("--raw-partitions", "0"),
            ("--raw-broker-max-bytes", "1000000001"),
        ] {
            assert!(parse(&["ingestion", flag, value, "validate"]).is_err());
        }
    }
}
