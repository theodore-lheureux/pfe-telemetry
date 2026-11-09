use crate::config::Config;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, OwnedResourceSpecifier, ResourceSpecifier},
    consumer::{BaseConsumer, CommitMode, Consumer},
};
use std::time::{Duration, Instant};

const RPC_TIMEOUT: Duration = Duration::from_secs(3);

fn consumer(config: &Config) -> Result<BaseConsumer, String> {
    ClientConfig::new()
        .set("bootstrap.servers", &config.bootstrap)
        .set("group.id", &config.group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "error")
        .set("allow.auto.create.topics", "false")
        .set("socket.timeout.ms", "3000")
        .create()
        .map_err(|error| error.to_string())
}

/// Initial snapshots only; later assignments and native errors belong to RustStream.
pub async fn preflight(config: Config) -> Result<(), String> {
    inspect(config, false).await
}

/// Explicit first-use initialization, never part of ordinary startup or replay.
pub async fn bootstrap(config: Config) -> Result<(), String> {
    inspect(config, true).await?;
    eprintln!("state=bootstrapped policy=explicit_retained_earliest");
    Ok(())
}

async fn inspect(config: Config, bootstrap: bool) -> Result<(), String> {
    config
        .limits
        .validate()
        .map_err(|error| error.to_string())?;
    config.validate_transport().map_err(str::to_owned)?;
    let declaration = config.clone();
    let (admin, consumer) = tokio::task::spawn_blocking(move || {
        let admin: AdminClient<_> = ClientConfig::new()
            .set("bootstrap.servers", &declaration.bootstrap)
            .set("allow.auto.create.topics", "false")
            .set("socket.timeout.ms", "3000")
            .create()
            .map_err(|error| error.to_string())?;
        // Validate topology while warming this admin client's metadata before DescribeConfigs.
        for (name, count) in [
            (&declaration.raw_topic, declaration.raw_partitions),
            (
                &declaration.normalized_topic,
                declaration.normalized_partitions,
            ),
        ] {
            let metadata = admin
                .inner()
                .fetch_metadata(Some(name), RPC_TIMEOUT)
                .map_err(|error| error.to_string())?;
            let topic = metadata
                .topics()
                .iter()
                .find(|topic| topic.name() == name)
                .ok_or("required topic missing")?;
            if topic.error().is_some()
                || topic
                    .partitions()
                    .iter()
                    .any(|p| p.error().is_some() || p.leader() < 0)
            {
                return Err("required topic unavailable".to_owned());
            }
            let mut ids = topic
                .partitions()
                .iter()
                .map(|p| p.id())
                .collect::<Vec<_>>();
            ids.sort_unstable();
            if ids != (0..count as i32).collect::<Vec<_>>() {
                return Err("topic partition count mismatch".to_owned());
            }
        }
        let consumer = consumer(&declaration)?;
        Ok((admin, consumer))
    })
    .await
    .map_err(|_| "startup metadata worker failed")??;
    let results = admin
        .describe_configs(
            &[
                ResourceSpecifier::Topic(&config.raw_topic),
                ResourceSpecifier::Topic(&config.normalized_topic),
            ],
            &AdminOptions::new().request_timeout(Some(RPC_TIMEOUT)),
        )
        .await
        .map_err(|error| error.to_string())?;
    if results.len() != 2 {
        return Err("incomplete topic configuration response".into());
    }
    for result in results {
        let resource = result.map_err(|error| format!("topic configuration: {error:?}"))?;
        let expected = match &resource.specifier {
            OwnedResourceSpecifier::Topic(name) if name == &config.raw_topic => {
                config.raw_broker_max_bytes
            }
            OwnedResourceSpecifier::Topic(name) if name == &config.normalized_topic => {
                config.normalized_broker_max_bytes
            }
            _ => return Err("unexpected topic configuration resource".into()),
        };
        let actual = resource
            .get("max.message.bytes")
            .and_then(|entry| entry.value.as_deref())
            .and_then(|value| value.parse::<usize>().ok());
        if actual != Some(expected) {
            return Err("topic max.message.bytes mismatch".into());
        }
    }
    tokio::task::spawn_blocking(move || {
        let mut query = TopicPartitionList::new();
        for p in 0..config.raw_partitions as i32 {
            query.add_partition(&config.raw_topic, p);
        }
        let committed = consumer
            .committed_offsets(query, RPC_TIMEOUT)
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + RPC_TIMEOUT;
        let mut seed = TopicPartitionList::new();
        for p in 0..config.raw_partitions as i32 {
            let entry = committed
                .find_partition(&config.raw_topic, p)
                .ok_or("checkpoint response missing partition")?;
            entry.error().map_err(|error| error.to_string())?;
            let saved = match entry.offset() {
                Offset::Offset(value) => Some(value),
                Offset::Invalid => None,
                _ => return Err("unexpected checkpoint type".into()),
            };
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("checkpoint snapshot deadline")?;
            let (low, high) = consumer
                .fetch_watermarks(&config.raw_topic, p, remaining)
                .map_err(|error| error.to_string())?;
            if bootstrap {
                if saved.is_some() {
                    return Err("bootstrap refuses existing checkpoints".into());
                }
                seed.add_partition_offset(&config.raw_topic, p, Offset::Offset(low))
                    .map_err(|error| error.to_string())?;
            } else {
                checkpoint(saved, low, high)?;
            }
        }
        if bootstrap {
            consumer.assign(&seed).map_err(|error| error.to_string())?;
            consumer
                .commit(&seed, CommitMode::Sync)
                .map_err(|_| "bootstrap commit unconfirmed; inspect checkpoints before retry")?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "startup snapshot worker failed")?
}

pub fn checkpoint(saved: Option<i64>, low: i64, high: i64) -> Result<i64, &'static str> {
    match saved {
        None => Err("checkpoint missing: explicit bootstrap required"),
        Some(value) if low >= 0 && high >= low && value >= low && value <= high => Ok(value),
        _ => Err("retention_gap: committed offset outside broker watermarks"),
    }
}
