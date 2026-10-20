use std::{net::SocketAddr, path::PathBuf};

use clap::{Args, Parser};

/// Broker connection shared by ingestion and storage.
#[derive(Args)]
pub struct BrokerConfig {
    #[arg(
        long,
        env = "TELEMETRY_KAFKA_BOOTSTRAP",
        default_value = "127.0.0.1:9092"
    )]
    pub kafka_bootstrap: String,
    #[arg(long, env = "TELEMETRY_KAFKA_TOPIC", default_value = "pfe.metrics.v1")]
    pub kafka_topic: String,
}

/// OTLP listener and source enrollment settings.
#[derive(Parser)]
#[command(
    name = "pfe-server",
    version,
    about = "Receive OTLP metrics and retain them in Kafka"
)]
pub struct IngestionConfig {
    #[arg(
        long,
        env = "TELEMETRY_INGESTION_ADDR",
        default_value = "127.0.0.1:4317"
    )]
    pub address: SocketAddr,
    #[arg(long, env = "TELEMETRY_INGESTION_SOURCES_FILE", hide_env_values = true)]
    pub sources_file: Option<PathBuf>,
    #[command(flatten)]
    pub broker: BrokerConfig,
}

/// Consumer progress and analytical file settings.
#[derive(Parser)]
#[command(
    name = "pfe-storage",
    version,
    about = "Publish retained OTLP measurements as Parquet"
)]
pub struct StorageConfig {
    #[command(flatten)]
    pub broker: BrokerConfig,
    #[arg(
        long,
        env = "TELEMETRY_STORAGE_KAFKA_GROUP",
        default_value = "pfe-storage-v1"
    )]
    pub kafka_group: String,
    #[arg(
        long,
        env = "TELEMETRY_STORAGE_DIRECTORY",
        default_value = ".state/measurements/v1"
    )]
    pub directory: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_and_worker_settings_are_independent() {
        let server = IngestionConfig::try_parse_from([
            "pfe-server",
            "--address",
            "127.0.0.1:4318",
            "--sources-file",
            "sources.json",
        ])
        .unwrap();
        assert_eq!(server.address.port(), 4318);
        assert_eq!(server.sources_file.unwrap(), PathBuf::from("sources.json"));
        assert!(IngestionConfig::try_parse_from(["pfe-server", "--address", "invalid"]).is_err());
        let worker = StorageConfig::try_parse_from([
            "pfe-storage",
            "--kafka-group",
            "replay",
            "--directory",
            "measurements",
        ])
        .unwrap();
        assert_eq!(worker.kafka_group, "replay");
        assert_eq!(worker.directory, PathBuf::from("measurements"));
    }
}
