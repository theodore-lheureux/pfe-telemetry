use std::error::Error;

use clap::Parser;
use pfe_server::config::{BrokerConfig, IngestionConfig};

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let IngestionConfig {
        address,
        sources_file,
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

    let router = if let Some(path) = sources_file {
        let sources = pfe_server::auth::Sources::load(&path)?;
        let sink = std::sync::Arc::new(pfe_server::broker::KafkaSink::new(
            &kafka_bootstrap,
            &kafka_topic,
        )?);
        pfe_server::configured_router(sources, sink).await
    } else {
        tracing::warn!("No source policies configured; telemetry acceptance is disabled");
        pfe_server::router().await
    };
    tracing::info!(%address, "Starting OTLP/gRPC server");
    router
        .serve_with_shutdown(address, pfe_server::shutdown_signal())
        .await?;
    Ok(())
}
