use crate::{Result, allocation::Allocation};
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    client::DefaultClientContext,
    consumer::{BaseConsumer, CommitMode, Consumer},
};
use serde::Serialize;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);

fn admin(allocation: &Allocation) -> Result<AdminClient<DefaultClientContext>> {
    Ok(ClientConfig::new()
        .set("bootstrap.servers", &allocation.broker)
        .create()?)
}

pub fn consumer(allocation: &Allocation, group: &str) -> Result<BaseConsumer> {
    Ok(ClientConfig::new()
        .set("bootstrap.servers", &allocation.broker)
        .set("group.id", group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "error")
        .set("allow.auto.create.topics", "false")
        .create()?)
}

/// Owned topics mirror `infra/kafka/init-topics.sh` except for their names and the
/// selected partition and byte-retention sizes.
pub async fn create_topics(allocation: &Allocation) -> Result<()> {
    let settings = &allocation.settings;
    let retention = settings.retention_bytes.to_string();
    fn topic<'a>(
        name: &'a str,
        partitions: u32,
        max_bytes: &'a str,
        retention: &'a str,
        codec: &'a str,
    ) -> NewTopic<'a> {
        NewTopic::new(name, partitions as i32, TopicReplication::Fixed(1))
            .set("retention.ms", "21600000")
            .set("retention.bytes", retention)
            .set("segment.bytes", "16777216")
            .set("segment.ms", "60000")
            .set("max.message.bytes", max_bytes)
            .set("cleanup.policy", "delete")
            .set("min.insync.replicas", "1")
            .set("unclean.leader.election.enable", "false")
            .set("compression.type", codec)
    }
    let topics = [
        topic(
            &allocation.raw_topic,
            settings.raw_partitions,
            "6291456",
            &retention,
            "zstd",
        ),
        topic(
            &allocation.normalized_topic,
            settings.normalized_partitions,
            "2097152",
            &retention,
            "zstd",
        ),
        topic(
            &allocation.late_topic,
            settings.normalized_partitions,
            "2097152",
            "134217728",
            "zstd",
        ),
        topic(
            &allocation.participant_topic,
            3,
            "6291456",
            "134217728",
            "zstd",
        ),
        topic(&allocation.live_topic, 8, "65536", "16777216", "producer")
            .set("retention.ms", "300000")
            .set("segment.bytes", "1048576"),
    ];
    let results = admin(allocation)?
        .create_topics(&topics, &AdminOptions::new().request_timeout(Some(TIMEOUT)))
        .await?;
    if let Some(error) = results.iter().find_map(|result| result.as_ref().err()) {
        return Err(format!("owned topic creation failed: {error:?}").into());
    }
    Ok(())
}

pub async fn delete_topics(allocation: &Allocation) -> Result<()> {
    let results = admin(allocation)?
        .delete_topics(
            &allocation.topics(),
            &AdminOptions::new().request_timeout(Some(TIMEOUT)),
        )
        .await?;
    let failed: Vec<_> = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .filter(|(_, code)| *code != rdkafka::types::RDKafkaErrorCode::UnknownTopicOrPartition)
        .collect();
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("owned topic cleanup failed: {failed:?}").into())
    }
}

/// Removes the allocation's consumer groups; deleting topics leaves their entries behind.
/// ClickHouse's consumers stay members until their session expires after their tables are
/// dropped, so non-empty groups are retried for up to 30 seconds.
pub async fn delete_groups(allocation: &Allocation) -> Result<()> {
    let admin = admin(allocation)?;
    let mut pending: Vec<String> = allocation.groups().iter().map(|g| g.to_string()).collect();
    for _ in 0..30 {
        let names: Vec<&str> = pending.iter().map(String::as_str).collect();
        let results = admin
            .delete_groups(&names, &AdminOptions::new().request_timeout(Some(TIMEOUT)))
            .await?;
        let mut busy = Vec::new();
        for result in results {
            match result {
                Ok(_) => {}
                Err((_, rdkafka::types::RDKafkaErrorCode::GroupIdNotFound)) => {}
                Err((group, rdkafka::types::RDKafkaErrorCode::NonEmptyGroup)) => busy.push(group),
                Err(error) => return Err(format!("owned group cleanup failed: {error:?}").into()),
            }
        }
        if busy.is_empty() {
            return Ok(());
        }
        pending = busy;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err(format!("owned groups still had members after 30 s: {pending:?}").into())
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct GroupLag {
    pub topic: String,
    pub group: String,
    pub low: i64,
    pub high: i64,
    pub committed: i64,
    pub lag: i64,
}

/// Total watermarks and committed offsets of one group over every partition of a topic.
pub fn lag(allocation: &Allocation, topic: &str, group: &str) -> Result<GroupLag> {
    let consumer = consumer(allocation, group)?;
    let metadata = consumer.fetch_metadata(Some(topic), TIMEOUT)?;
    let partitions = metadata
        .topics()
        .iter()
        .find(|t| t.name() == topic)
        .ok_or("topic missing")?
        .partitions()
        .len() as i32;
    let mut list = TopicPartitionList::new();
    let mut result = GroupLag {
        topic: topic.into(),
        group: group.into(),
        ..Default::default()
    };
    let mut highs = Vec::new();
    for partition in 0..partitions {
        let (low, high) = consumer.fetch_watermarks(topic, partition, TIMEOUT)?;
        result.low += low;
        result.high += high;
        highs.push((low, high));
        list.add_partition(topic, partition);
    }
    let committed = consumer.committed_offsets(list, TIMEOUT)?;
    for (partition, (low, high)) in highs.into_iter().enumerate() {
        let offset = match committed
            .find_partition(topic, partition as i32)
            .map(|p| p.offset())
        {
            Some(Offset::Offset(offset)) => offset,
            _ => low,
        };
        result.committed += offset;
        result.lag += (high - offset).max(0);
    }
    Ok(result)
}

pub async fn group_empty(allocation: &Allocation, group: &str) -> Result<bool> {
    let consumer = consumer(allocation, group)?;
    let list = consumer.fetch_group_list(Some(group), TIMEOUT)?;
    Ok(list
        .groups()
        .iter()
        .all(|g| g.state() == "Empty" || g.state() == "Dead"))
}

pub async fn rewind(
    allocation: &Allocation,
    topic: &str,
    group: &str,
    records: i64,
) -> Result<i64> {
    let consumer = consumer(allocation, group)?;
    let state = lag(allocation, topic, group)?;
    let partitions = consumer
        .fetch_metadata(Some(topic), TIMEOUT)?
        .topics()
        .first()
        .ok_or("topic missing")?
        .partitions()
        .len() as i32;
    let mut current = TopicPartitionList::new();
    for partition in 0..partitions {
        current.add_partition(topic, partition);
    }
    let committed = consumer.committed_offsets(current, TIMEOUT)?;
    let mut target = TopicPartitionList::new();
    let mut moved = 0;
    for partition in 0..partitions {
        let (low, _) = consumer.fetch_watermarks(topic, partition, TIMEOUT)?;
        let Some(Offset::Offset(offset)) = committed
            .find_partition(topic, partition)
            .map(|p| p.offset())
        else {
            continue;
        };
        let rewound = (offset - records).max(low);
        moved += offset - rewound;
        target.add_partition_offset(topic, partition, Offset::Offset(rewound))?;
    }
    if state.lag != 0 {
        eprintln!("rewind_with_existing_lag={}", state.lag);
    }
    consumer.assign(&target)?;
    consumer.commit(&target, CommitMode::Sync)?;
    Ok(moved)
}

/// Retained bytes per topic from the broker's log directories, through a read-only
/// `kafka-log-dirs.sh` inside the explicitly named broker container.
pub async fn retained_bytes(allocation: &Allocation) -> Result<serde_json::Value> {
    let Ok(container) = std::env::var("RECOUNT_LOAD_KAFKA_CONTAINER") else {
        return Ok(serde_json::Value::Null);
    };
    let topics = [
        allocation.raw_topic.as_str(),
        &allocation.normalized_topic,
        &allocation.late_topic,
    ];
    let output = tokio::process::Command::new("docker")
        .args([
            "exec",
            &container,
            "/opt/kafka/bin/kafka-log-dirs.sh",
            "--bootstrap-server",
            "localhost:9092",
            "--describe",
            "--topic-list",
            &topics.join(","),
        ])
        .output()
        .await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or("no log-dirs JSON")?;
    let report: serde_json::Value = serde_json::from_str(line)?;
    let mut sizes = serde_json::Map::new();
    for topic in topics {
        let mut total = 0;
        for broker in report["brokers"].as_array().into_iter().flatten() {
            for directory in broker["logDirs"].as_array().into_iter().flatten() {
                for partition in directory["partitions"].as_array().into_iter().flatten() {
                    let name = partition["partition"].as_str().unwrap_or_default();
                    if name.rsplit_once('-').is_some_and(|(t, _)| t == topic) {
                        total += partition["size"].as_u64().unwrap_or_default();
                    }
                }
            }
        }
        sizes.insert(topic.to_owned(), total.into());
    }
    Ok(sizes.into())
}
