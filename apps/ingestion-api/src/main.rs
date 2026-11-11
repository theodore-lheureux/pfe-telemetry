use clap::Parser;
use recount_ingestion_api::{
    Result,
    auth::NodeTokens,
    broker::{KafkaSink, Sink},
    config::{Command, Config},
};
use std::sync::Arc;

fn main() -> Result<()> {
    let config = Config::parse();
    let limits = config.limits().unwrap_or_else(|error| error.exit());
    if config.command == Some(Command::Validate) {
        println!("configuration valid (declarations only; backend state not checked)");
        return Ok(());
    }
    serve(config, limits)
}

#[tokio::main]
async fn serve(
    config: Config,
    limits: recount_telemetry_validation::validate::Limits,
) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let authority = Arc::new(NodeTokens::new(
        config
            .database_url
            .as_deref()
            .expect("Clap requires a database URL for service operation"),
        &config.collector_public_keys,
    )?);
    authority.spawn_revocation_poller();
    let sink = Arc::new(KafkaSink::new(
        &config.kafka_bootstrap,
        &config.raw_topic,
        config.raw_partitions,
        limits.decoded_bytes,
        config.raw_broker_max_bytes,
        config.live_topic.clone(),
        config.live_partitions,
    )?);
    if !sink.ready().await {
        return Err(
            "Raw topic metadata does not match configured partitions or is unavailable".into(),
        );
    }
    recount_ingestion_api::configured_router(
        authority,
        sink,
        limits,
        config.max_in_flight as usize,
    )
    .await?
    .serve_with_shutdown(config.addr, recount_ingestion_api::shutdown_signal())
    .await?;
    Ok(())
}
