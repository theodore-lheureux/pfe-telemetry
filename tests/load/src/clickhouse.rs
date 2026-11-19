use crate::{
    Result,
    allocation::{Allocation, setting},
    kafka, workload,
};
use clap::Subcommand;
use recount_telemetry_schema::ddl::{ParticipantSchema, Schema};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

#[derive(Clone)]
pub struct ClickHouse {
    url: String,
    credentials: Arc<Credentials>,
}

/// A private curl configuration holding the user, so the password never appears in a
/// process argument list.
struct Credentials(PathBuf);

impl Drop for Credentials {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn escaped(value: &str) -> String {
    value.bytes().map(|byte| format!("%{byte:02X}")).collect()
}

impl ClickHouse {
    pub fn from_env() -> Result<Self> {
        let url = setting("RECOUNT_CLICKHOUSE_TEST_URL")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("ClickHouse URL must be HTTP(S)".into());
        }
        let user = format!(
            "{}:{}",
            setting("RECOUNT_CLICKHOUSE_TEST_USER")?,
            setting("RECOUNT_CLICKHOUSE_TEST_PASSWORD")?
        );
        let path = std::env::temp_dir().join(format!(
            "recount-load-curl-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7().simple()
        ));
        crate::allocation::write_private(
            &path,
            format!(
                "user = \"{}\"\n",
                user.replace('\\', "\\\\").replace('"', "\\\"")
            )
            .as_bytes(),
        )?;
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            credentials: Arc::new(Credentials(path)),
        })
    }

    /// Sends the statement as the request body, so literals such as passwords stay out of
    /// the URL.
    pub async fn query(&self, sql: &str) -> Result<String> {
        self.send(
            &format!("{}/?wait_end_of_query=1", self.url),
            sql.as_bytes(),
            60,
        )
        .await
    }

    /// An INSERT statement in the URL with its data as the body.
    pub async fn request(&self, sql: &str, data: &[u8], timeout: u64) -> Result<String> {
        self.send(
            &format!("{}/?wait_end_of_query=1&query={}", self.url, escaped(sql)),
            data,
            timeout,
        )
        .await
    }

    async fn send(&self, url: &str, body: &[u8], timeout: u64) -> Result<String> {
        let mut child = Command::new("curl")
            .args(["--silent", "--show-error", "--fail-with-body", "--max-time"])
            .arg(timeout.to_string())
            .arg("--config")
            .arg(&self.credentials.0)
            .arg(url)
            .args(["--data-binary", "@-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or("curl stdin")?;
        stdin.write_all(body).await?;
        drop(stdin);
        let output = child.wait_with_output().await?;
        if !output.status.success() {
            return Err(format!(
                "ClickHouse query failed: {}{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            )
            .into());
        }
        Ok(String::from_utf8(output.stdout)?)
    }

    pub async fn number(&self, sql: &str) -> Result<u64> {
        Ok(self.query(sql).await?.trim().parse()?)
    }

    pub async fn create(&self, allocation: &Allocation) -> Result<()> {
        let ddl = Schema {
            database: &allocation.database,
            bootstrap: &allocation.internal_broker,
            topic: &allocation.normalized_topic,
            group: &allocation.clickhouse_group,
            late_topic: &allocation.late_topic,
            late_group: &allocation.clickhouse_late_group,
            partition_limit: allocation.output_rows,
            poll_ms: 100,
            flush_ms: recount_telemetry_schema::ddl::FLUSH_MS,
            if_not_exists: false,
        }
        .render()?;
        let participants = ParticipantSchema {
            database: &allocation.database,
            bootstrap: &allocation.internal_broker,
            topic: &allocation.participant_topic,
            group: &allocation.participant_group,
            partition_limit: allocation.output_rows,
        }
        .render()?;
        for statement in ddl
            .split(';')
            .chain(participants.split(';'))
            .filter(|s| !s.trim().is_empty())
        {
            self.query(statement).await?;
        }
        self.query(&format!(
            "CREATE USER {} IDENTIFIED WITH sha256_password BY '{}' SETTINGS PROFILE 'telemetry_read'",
            allocation.reader_user, allocation.reader_password
        ))
        .await?;
        self.query(&format!(
            "GRANT SELECT ON {}.* TO {}",
            allocation.database, allocation.reader_user
        ))
        .await?;
        let facts = workload::participant_facts(allocation);
        if !facts.is_empty() {
            self.request(
                &format!(
                    "INSERT INTO {}.execution_participants SETTINGS format_schema='executions.proto:AnalyticalParticipant', format_protobuf_use_autogenerated_schema=0 FORMAT Protobuf",
                    allocation.database
                ),
                &facts,
                60,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn drop(&self, allocation: &Allocation) -> Result<()> {
        self.query(&format!(
            "DROP DATABASE IF EXISTS {} SYNC",
            allocation.database
        ))
        .await?;
        self.query(&format!("DROP USER IF EXISTS {}", allocation.reader_user))
            .await?;
        Ok(())
    }
}

#[derive(Clone, Copy, Subcommand)]
pub enum ConsumerAction {
    /// Detach the native consumer and its view; the group leaves and stops committing.
    Pause,
    /// Attach the native consumer and its view again.
    Resume,
    /// Move the paused, idle group back by this many records per partition, as a crash
    /// between a stored insert and its offset commit would leave it.
    Rewind {
        records: i64,
    },
    /// Detach only the destination table; the consumer keeps polling but cannot insert.
    DetachDestination,
    AttachDestination,
}

/// Applies the action; a rewind returns how many records it moved the checkpoint back.
pub async fn consumer(allocation: &Allocation, action: ConsumerAction) -> Result<Option<i64>> {
    allocation.validate_owned()?;
    let clickhouse = allocation.clickhouse()?;
    let database = &allocation.database;
    match action {
        ConsumerAction::Pause => {
            clickhouse
                .query(&format!(
                    "DETACH TABLE {database}.ingest_metric_points SYNC"
                ))
                .await?;
            clickhouse
                .query(&format!("DETACH TABLE {database}.normalized_kafka SYNC"))
                .await?;
        }
        ConsumerAction::Resume => {
            clickhouse
                .query(&format!("ATTACH TABLE {database}.normalized_kafka"))
                .await?;
            clickhouse
                .query(&format!("ATTACH TABLE {database}.ingest_metric_points"))
                .await?;
        }
        ConsumerAction::Rewind { records } => {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
            while !kafka::group_empty(allocation, &allocation.clickhouse_group).await? {
                if tokio::time::Instant::now() > deadline {
                    return Err("owned ClickHouse group did not become idle; no rewind".into());
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let moved = kafka::rewind(
                allocation,
                &allocation.normalized_topic,
                &allocation.clickhouse_group,
                records,
            )
            .await?;
            eprintln!("rewound_records={moved}");
            return Ok(Some(moved));
        }
        ConsumerAction::DetachDestination => {
            clickhouse
                .query(&format!("DETACH TABLE {database}.metric_points SYNC"))
                .await?;
        }
        ConsumerAction::AttachDestination => {
            clickhouse
                .query(&format!("ATTACH TABLE {database}.metric_points"))
                .await?;
        }
    }
    Ok(None)
}
