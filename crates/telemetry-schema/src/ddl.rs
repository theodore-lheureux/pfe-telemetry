use std::io;

pub const TEMPLATE: &str = include_str!("../../../infra/clickhouse/schema.sql.in");
pub const BLOCK_ROWS: u32 = 64;
pub const POLL_MESSAGES: u32 = 32;
pub const FLUSH_MS: u32 = 2000;

pub struct Batching {
    pub block_rows: u32,
    pub poll_messages: u32,
}

impl Batching {
    pub fn for_partition_limit(partitions: u32) -> io::Result<Self> {
        if partitions == 0 {
            return Err(io::Error::other("positive insert partition limit required"));
        }
        let block_rows = partitions.min(BLOCK_ROWS);
        // KafkaSource checks the row target after finishing an already-fetched poll.
        let poll_messages = POLL_MESSAGES.min(partitions - block_rows + 1);
        Ok(Self {
            block_rows,
            poll_messages,
        })
    }

    pub fn maximum_rows(&self) -> u32 {
        self.block_rows + self.poll_messages - 1
    }
}

pub struct Schema<'a> {
    pub database: &'a str,
    pub bootstrap: &'a str,
    pub topic: &'a str,
    pub group: &'a str,
    pub partition_limit: u32,
    pub poll_ms: u32,
    pub flush_ms: u32,
    pub if_not_exists: bool,
}

impl Schema<'_> {
    pub fn render(&self) -> io::Result<String> {
        let batching = Batching::for_partition_limit(self.partition_limit)?;
        let identifier = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        };
        let kafka_name = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        if !identifier(self.database)
            || !kafka_name(self.topic)
            || !kafka_name(self.group)
            || self.bootstrap.is_empty()
            || !self
                .bootstrap
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:,[]-".contains(&b))
            || self.poll_ms == 0
            || self.poll_ms > i32::MAX as u32
            || self.flush_ms == 0
            || self.flush_ms > i32::MAX as u32
        {
            return Err(io::Error::other("invalid ClickHouse schema inputs"));
        }
        let columns = crate::ANALYTICAL_COLUMNS.trim();
        if columns.is_empty() || columns.contains(';') || columns.contains("__") {
            return Err(io::Error::other("invalid generated columns"));
        }
        let mut sql = TEMPLATE.to_owned();
        for (token, value) in [
            ("__DATABASE__", self.database.to_owned()),
            (
                "__CREATE_GUARD__",
                if self.if_not_exists {
                    "IF NOT EXISTS "
                } else {
                    ""
                }
                .to_owned(),
            ),
            ("__ANALYTICAL_COLUMNS__", columns.to_owned()),
            ("__KAFKA_BOOTSTRAP__", self.bootstrap.to_owned()),
            ("__NORMALIZED_TOPIC__", self.topic.to_owned()),
            ("__CONSUMER_GROUP__", self.group.to_owned()),
            ("__BLOCK_ROWS__", batching.block_rows.to_string()),
            ("__POLL_MESSAGES__", batching.poll_messages.to_string()),
            ("__POLL_MS__", self.poll_ms.to_string()),
            ("__FLUSH_MS__", self.flush_ms.to_string()),
        ] {
            sql = sql.replace(token, &value);
        }
        if sql.contains("__") {
            return Err(io::Error::other("unresolved DDL placeholder"));
        }
        Ok(sql)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_names_and_strict_object_creation_are_rendered_without_sql_injection() {
        let mut schema = Schema {
            database: "disposable",
            bootstrap: "kafka:9092",
            topic: "test.normalized",
            group: "test.consumer",
            partition_limit: 128,
            poll_ms: 100,
            flush_ms: 1000,
            if_not_exists: false,
        };
        let sql = schema.render().unwrap();
        assert!(sql.contains("CREATE TABLE disposable.metric_points"));
        assert!(sql.contains("kafka_group_name = 'test.consumer'"));
        assert!(sql.contains("kafka_topic_list = 'test.normalized'"));
        assert!(!sql.contains("telemetry."));
        assert!(!sql.contains("__"));
        schema.database = "other; DROP DATABASE telemetry";
        assert!(schema.render().is_err());
        schema.database = "disposable";
        schema.group = "consumer'";
        assert!(schema.render().is_err());
    }

    #[test]
    fn complete_poll_overshoot_stays_within_the_insert_partition_guard() {
        for partitions in [1, 2, 32, 64, 65, 95, 128, 16384] {
            let batching = Batching::for_partition_limit(partitions).unwrap();
            assert!(batching.block_rows > 0 && batching.poll_messages > 0);
            assert!(batching.maximum_rows() <= partitions);
        }
        let batching = Batching::for_partition_limit(128).unwrap();
        assert_eq!(batching.block_rows, 64);
        assert_eq!(batching.poll_messages, 32);
        assert_eq!(batching.maximum_rows(), 95);
        assert!(Batching::for_partition_limit(0).is_err());
    }
}
