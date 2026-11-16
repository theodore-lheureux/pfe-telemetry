//! Durable environment-labelled facts, separate from OTLP measurements.
mod discovery;
mod engine;
mod environment;
mod export;
mod settings;
mod store;
#[cfg(test)]
mod test_support;
mod wiring;

use std::{path::Path, sync::Arc, time::Duration};

use tokio::sync::{Mutex, Notify, watch};
use tonic::transport::Endpoint;

use crate::{enrollment::Authorization, spool::Result};
use settings::Settings;

pub(crate) use wiring::Setup;

#[derive(Clone)]
pub(super) struct Scope {
    pub project: String,
    pub node: String,
    pub host: String,
    pub boot: String,
    pub namespace: String,
}

struct Runtime {
    settings: Settings,
    scope: Scope,
    endpoint: Endpoint,
    authorization: Authorization,
    period: Duration,
    drain: bool,
}

type SharedStore = Arc<Mutex<store::Store>>;

async fn run(config: Runtime, directory: &Path, stopped: watch::Receiver<bool>) -> Result<()> {
    let destination = format!("{}#node={}", config.endpoint.uri(), config.scope.node);
    let opened = store::Store::open(directory, &destination, &config.settings).await?;
    let store = Arc::new(Mutex::new(opened));
    let notify = Arc::new(Notify::new());
    let exporter = export::run(
        export::Client::new(config.endpoint),
        store.clone(),
        config.authorization,
        config.drain,
        config.settings.max_exports,
        notify.clone(),
        stopped.clone(),
    );
    let result = if config.drain {
        exporter.await
    } else {
        tokio::try_join!(
            collect(
                config.scope,
                config.settings,
                config.period,
                store.clone(),
                notify,
                stopped
            ),
            exporter
        )
        .map(|_| ())
    };
    let closed = Arc::try_unwrap(store)
        .map_err(|_| std::io::Error::other("Participant queue still in use"))?
        .into_inner()
        .close()
        .await;
    result?;
    closed
}

async fn collect(
    scope: Scope,
    settings: Settings,
    period: Duration,
    store: SharedStore,
    notify: Arc<Notify>,
    mut stopped: watch::Receiver<bool>,
) -> Result<()> {
    let facts = store.lock().await.facts().await?;
    let mut discovery = discovery::Discovery::new(&scope, settings.clone(), &facts)?;
    let mut engine = engine::Engine::new(scope, settings.max_facts);
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            _ = interval.tick() => {}
        }
        let (returned, scan) = tokio::task::spawn_blocking(move || -> Result<_> {
            let scan = discovery.scan()?;
            Ok((discovery, scan))
        })
        .await??;
        discovery = returned;
        let started = std::time::Instant::now();
        engine.scan(&mut *store.lock().await, &scan).await?;
        tracing::debug!(
            reconcile_micros = started.elapsed().as_micros(),
            "Execution facts reconciled"
        );
        notify.notify_one();
    }
}
