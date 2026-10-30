use std::error::Error;

use clap::Parser;
use pfe_server::config::{BrokerConfig, IngestionConfig};

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let IngestionConfig {
        address,
        database_url,
        broker: BrokerConfig {
            kafka_bootstrap,
            kafka_topic,
        },
    } = IngestionConfig::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let router = if let Some(database_url) = database_url {
        let credentials = pfe_server::auth::Credentials::new(&database_url)?;
        let sink = std::sync::Arc::new(pfe_server::broker::KafkaSink::new(
            &kafka_bootstrap,
            &kafka_topic,
        )?);
        pfe_server::configured_router(credentials, sink).await
    } else {
        tracing::warn!("No credential database configured; telemetry acceptance is disabled");
        pfe_server::router().await
    };
    tracing::info!(%address, "Starting OTLP/gRPC server");
    router
        .serve_with_shutdown(address, pfe_server::shutdown_signal())
        .await?;
    Ok(())
}
