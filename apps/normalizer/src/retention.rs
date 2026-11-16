use std::{fmt, fs, io, path::PathBuf, sync::Mutex};
use tracing::{
    Event, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

pub struct RetentionMetrics {
    group: String,
    metrics_file: Option<PathBuf>,
    gaps: Mutex<u64>,
}

impl RetentionMetrics {
    pub fn new(group: String, metrics_file: Option<PathBuf>) -> Result<Self, String> {
        let metrics = Self {
            group,
            metrics_file,
            gaps: Mutex::new(0),
        };
        metrics.export(0).map_err(|error| error.to_string())?;
        Ok(metrics)
    }

    fn export(&self, total: u64) -> io::Result<()> {
        if let Some(path) = &self.metrics_file {
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            fs::write(
                &temporary,
                format!(
                    "# HELP recount_normalizer_retention_gaps_total Native offset resets after unavailable offsets.\n# TYPE recount_normalizer_retention_gaps_total counter\nrecount_normalizer_retention_gaps_total {total}\n"
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
        let mut total = self.gaps.lock().expect("retention counter");
        *total = total.saturating_add(1);
        eprintln!(
            "level=WARN event=retention_gap action=resume_earliest group={} metric=recount_normalizer_retention_gaps_total value={total} detail={}",
            self.group, message.0
        );
        if let Err(error) = self.export(*total) {
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
        let subscriber = tracing_subscriber::registry().with(metrics);
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
        fs::remove_file(file).unwrap();
    }
}
