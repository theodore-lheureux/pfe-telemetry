use std::sync::Arc;

use clap::Parser;
use pfe_server::{Result, analytics::Store, broker, config::StorageConfig};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let config = StorageConfig::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let store = Arc::new(Store::new(
        &config.clickhouse_url,
        &config.clickhouse_user,
        &config.clickhouse_password,
    ));
    let consumer = broker::consumer(
        &config.broker.kafka_bootstrap,
        &config.broker.kafka_topic,
        &config.kafka_group,
    )?;
    let shutdown = pfe_server::shutdown_signal();
    tokio::pin!(shutdown);
    tracing::info!("Processing retained telemetry into ClickHouse");
    loop {
        tokio::select! {
            () = &mut shutdown => break,
            result = broker::consume_one(&consumer, store.clone()) => { result?; },
        }
    }
    Ok(())
}
