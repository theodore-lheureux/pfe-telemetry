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
    #[arg(long, env = "TELEMETRY_INGESTION_DATABASE_URL", hide_env_values = true)]
    pub database_url: Option<String>,
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
            "--database-url",
            "postgresql://reader@localhost/pfe?sslmode=disable",
        ])
        .unwrap();
        assert_eq!(server.address.port(), 4318);
        assert!(
            server
                .database_url
                .unwrap()
                .starts_with("postgresql://reader@")
        );
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
