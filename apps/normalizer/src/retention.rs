use std::{
    fmt, fs, io,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tracing::{
    Event, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

#[derive(Clone)]
pub struct RetentionMetrics {
    group: String,
    metrics_file: Option<PathBuf>,
    snapshot: Arc<Mutex<Snapshot>>,
}

#[derive(Default)]
struct Snapshot {
    gaps: u64,
    cache: String,
}

impl RetentionMetrics {
    pub fn new(group: String, metrics_file: Option<PathBuf>) -> Result<Self, String> {
        let metrics = Self {
            group,
            metrics_file,
            snapshot: Arc::default(),
        };
        metrics
            .export(&Snapshot::default())
            .map_err(|error| error.to_string())?;
        Ok(metrics)
    }

    pub(crate) fn enabled(&self) -> bool {
        self.metrics_file.is_some()
    }

    pub(crate) fn update_cache(&self, cache: String) -> io::Result<()> {
        let mut snapshot = self.snapshot.lock().expect("metrics snapshot");
        snapshot.cache = cache;
        self.export(&snapshot)
    }

    fn export(&self, snapshot: &Snapshot) -> io::Result<()> {
        if let Some(path) = &self.metrics_file {
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            fs::write(
                &temporary,
                format!(
                    "# HELP recount_normalizer_retention_gaps_total Native offset resets after unavailable offsets.\n# TYPE recount_normalizer_retention_gaps_total counter\nrecount_normalizer_retention_gaps_total {}\n{}",
                    snapshot.gaps, snapshot.cache,
                ),
            )?;
            fs::rename(temporary, path)?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct Message(String);

impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

impl<S: Subscriber> Layer<S> for RetentionMetrics {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        if event.metadata().target() != "librdkafka" || *event.metadata().level() != Level::WARN {
            return;
        }
        // RustStream owns the consumer context. Its rdkafka tracing feature forwards
        // error-driven native OFFSET warnings; fresh-group starts are debug-logged.
        let mut message = Message::default();
        event.record(&mut message);
        if !message.0.starts_with("librdkafka: OFFSET ") || !message.0.contains("offset reset") {
            return;
        }
        let mut snapshot = self.snapshot.lock().expect("metrics snapshot");
        snapshot.gaps = snapshot.gaps.saturating_add(1);
        eprintln!(
            "level=WARN event=retention_gap action=resume_earliest group={} metric=recount_normalizer_retention_gaps_total value={} detail={}",
            self.group, snapshot.gaps, message.0
        );
        if let Err(error) = self.export(&snapshot) {
            eprintln!("level=WARN event=retention_metrics_export_failed error={error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tracing_subscriber::prelude::*;

    #[test]
    fn native_resets_increment_an_exported_counter_without_counting_other_logs() {
        let file = std::env::temp_dir().join(format!(
            "recount-retention-{}-{}.prom",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let metrics = RetentionMetrics::new("recount.test".into(), Some(file.clone())).unwrap();
        let cache = "recount_normalizer_identity_cache_hits_total{cache_kind=\"series\"} 3\n";
        metrics.update_cache(cache.into()).unwrap();
        let subscriber = tracing_subscriber::registry().with(metrics.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "librdkafka", "librdkafka: OFFSET raw [0]: offset reset: no offset stored");
            tracing::warn!(target: "librdkafka", "librdkafka: CONNECT broker unavailable");
            tracing::warn!(target: "librdkafka", "librdkafka: OFFSET raw [0]: offset reset to BEGINNING: Broker: Offset out of range");
        });
        assert!(
            fs::read_to_string(&file)
                .unwrap()
                .contains("recount_normalizer_retention_gaps_total 1\n")
        );
        assert!(fs::read_to_string(&file).unwrap().contains(cache));
        metrics.update_cache(cache.replace(" 3\n", " 4\n")).unwrap();
        let contents = fs::read_to_string(&file).unwrap();
        assert!(contents.contains("recount_normalizer_retention_gaps_total 1\n"));
        assert!(contents.contains("cache_kind=\"series\"} 4\n"));
        fs::remove_file(file).unwrap();
    }
}
