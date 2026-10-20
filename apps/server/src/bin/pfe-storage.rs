use std::sync::Arc;

use clap::Parser;

use pfe_server::{
    Result, broker,
    config::{BrokerConfig, StorageConfig},
    storage::Store,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let StorageConfig {
        broker:
            BrokerConfig {
                kafka_bootstrap,
                kafka_topic: topic,
            },
        kafka_group: group,
        directory,
    } = StorageConfig::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let store = Arc::new(Store::open(&directory)?);
    let consumer = broker::consumer(&kafka_bootstrap, &topic, &group)?;
    let shutdown = pfe_server::shutdown_signal();
    tokio::pin!(shutdown);
    tracing::info!(%topic, %group, "Processing retained telemetry");
    loop {
        // Cancellation can leave a published file without a committed offset. Replay recognizes it.
        tokio::select! {
            () = &mut shutdown => break,
            result = broker::consume_one(&consumer, store.clone()) => { result?; },
        }
    }
    Ok(())
}
