use std::net::SocketAddr;

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

/// Consumer progress and analytical storage settings.
#[derive(Parser)]
#[command(
    name = "pfe-storage",
    version,
    about = "Persist retained OTLP measurements in ClickHouse"
)]
pub struct StorageConfig {
    #[command(flatten)]
    pub broker: BrokerConfig,
    #[arg(
        long,
        env = "TELEMETRY_STORAGE_KAFKA_GROUP",
        default_value = "pfe-storage"
    )]
    pub kafka_group: String,
    #[arg(long, env = "TELEMETRY_CLICKHOUSE_URL")]
    pub clickhouse_url: String,
    #[arg(
        long,
        env = "TELEMETRY_CLICKHOUSE_USER",
        default_value = "telemetry_writer"
    )]
    pub clickhouse_user: String,
    #[arg(long, env = "TELEMETRY_CLICKHOUSE_PASSWORD", hide_env_values = true)]
    pub clickhouse_password: String,
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
            "--clickhouse-url",
            "http://localhost:8123",
            "--clickhouse-password",
            "test-only",
        ])
        .unwrap();
        assert_eq!(worker.kafka_group, "replay");
        assert_eq!(worker.clickhouse_url, "http://localhost:8123");
    }
}
