//! Bounded persistent OTLP batches. A successful enqueue commits before export.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use prost::Message;
use sqlx::{
    ConnectOptions, Connection, Row, SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteRow},
};
use uuid::Uuid;

use crate::{LossReason, LossTracker};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// An encoded OTLP request whose identity and payload stay unchanged on retry.
#[derive(Clone, Debug)]
pub struct Batch {
    pub sequence: i64,
    pub id: String,
    pub created_ns: u64,
    pub epoch: String,
    pub points: u64,
    pub payload: Vec<u8>,
}

impl Batch {
    pub fn new(epoch: String, request: ExportMetricsServiceRequest, points: u64) -> Result<Self> {
        let payload = request.encode_to_vec();
        if payload.len() > MAX_REQUEST_BYTES {
            return Err(io::Error::other("OTLP batch exceeds the request limit").into());
        }
        Ok(Self {
            sequence: 0,
            id: Uuid::now_v7().to_string(),
            created_ns: unix_nanos()?,
            epoch,
            points,
            payload,
        })
    }

    pub fn expired(&self, now_ns: u64, max_age_ns: u64) -> bool {
        now_ns.saturating_sub(self.created_ns) >= max_age_ns
    }
}

pub fn unix_nanos() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
    )?)
}

/// A destination-bound SQLite upload queue with byte and batch-count limits.
pub struct Spool {
    connection: Option<SqliteConnection>,
    lock: Option<File>,
    runtime: tokio::runtime::Handle,
    max_bytes: u64,
    max_batches: u64,
}

impl Spool {
    pub async fn open(
        directory: &Path,
        destination: &str,
        max_bytes: u64,
        max_batches: u64,
    ) -> Result<Self> {
        Self::open_with_options(
            directory,
            destination,
            max_bytes,
            max_batches,
            SqliteConnectOptions::new(),
        )
        .await
    }

    async fn open_with_options(
        directory: &Path,
        destination: &str,
        max_bytes: u64,
        max_batches: u64,
        options: SqliteConnectOptions,
    ) -> Result<Self> {
        if max_bytes == 0 || max_batches == 0 {
            return Err(io::Error::other("Queue limits must be positive").into());
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir() {
            return Err(io::Error::other("Queue path must be a directory, not a symlink").into());
        }
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err(io::Error::other(
                "Queue directory must have mode 0700; existing permissions were left unchanged",
            )
            .into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("queue.lock"))?;
        lock.try_lock()?;
        let database = directory.join("queue.sqlite3");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&database)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        let options = options
            .filename(database)
            .foreign_keys(false)
            .statement_cache_capacity(0)
            .command_buffer_size(1)
            .row_buffer_size(1);
        let destination = destination.to_owned();
        let runtime = tokio::runtime::Handle::current();
        let connection_runtime = runtime.clone();
        // Cancelling the await must not cancel connection establishment or drop
        // ownership while SQLx's independent worker can still access the queue.
        // An unclaimed successful result drops Spool and retains the lock through close.
        tokio::task::spawn_blocking(move || {
            runtime.block_on(async move {
                let connection = options.connect().await?;
                let mut queue = Self {
                    connection: Some(connection),
                    lock: Some(lock),
                    runtime: connection_runtime,
                    max_bytes,
                    max_batches,
                };
                if let Err(error) = queue.initialize(&destination).await {
                    queue.close().await?;
                    return Err(error);
                }
                Ok(queue)
            })
        })
        .await?
    }

    fn connection(&mut self) -> &mut SqliteConnection {
        self.connection.as_mut().expect("Queue is open")
    }

    async fn initialize(&mut self, destination: &str) -> Result<()> {
        // DELETE avoids an ever-growing WAL. FULL syncs commits and the rollback
        // journal. The directory must reside on a local, reliable filesystem.
        sqlx::raw_sql(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            PRAGMA cache_size=-1024; PRAGMA temp_store=MEMORY;",
        )
        .execute(self.connection())
        .await?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(self.connection())
            .await?;
        if !matches!(version, 0 | 1) {
            return Err(io::Error::other("Unsupported queue schema version").into());
        }
        let mut transaction = self.connection().begin_with("BEGIN IMMEDIATE").await?;
        sqlx::raw_sql(
            "
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS batches (
                sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                created_ns INTEGER NOT NULL, epoch TEXT NOT NULL,
                points INTEGER NOT NULL, payload BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS losses (reason INTEGER PRIMARY KEY, points INTEGER NOT NULL);
            PRAGMA user_version=1;",
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        sqlx::query("INSERT OR IGNORE INTO settings VALUES ('destination', ?1)")
            .bind(destination)
            .execute(self.connection())
            .await?;
        let stored: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='destination'")
                .fetch_one(self.connection())
                .await?;
        if stored != destination {
            return Err(io::Error::other(
                "Queue destination changed; use a separate queue directory",
            )
            .into());
        }
        // Bound physical database growth as well as queued payload. Leave room
        // for B-tree fragmentation, row metadata and three loss counters.
        let page_size = u64::try_from(
            sqlx::query_scalar::<_, i64>("PRAGMA page_size")
                .fetch_one(self.connection())
                .await?,
        )?;
        let disk_budget = self
            .max_bytes
            .checked_mul(2)
            .and_then(|bytes| {
                self.max_batches
                    .checked_mul(512)
                    .and_then(|rows| bytes.checked_add(rows))
            })
            .and_then(|bytes| bytes.checked_add(1024 * 1024))
            .ok_or_else(|| io::Error::other("Queue disk budget overflow"))?;
        let pages = i64::try_from(disk_budget / page_size + 1)?;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA max_page_count={pages}"
        )))
        .execute(self.connection())
        .await?;
        let (bytes, count) = self.usage().await?;
        if bytes > self.max_bytes || count > self.max_batches {
            return Err(io::Error::other(
                "Existing queue exceeds configured limits; restore the previous limits",
            )
            .into());
        }
        Ok(())
    }

    pub async fn usage(&mut self) -> Result<(u64, u64)> {
        let row = sqlx::query("SELECT COALESCE(SUM(length(payload)), 0), COUNT(*) FROM batches")
            .fetch_one(self.connection())
            .await?;
        Ok((unsigned(&row, 0)?, unsigned(&row, 1)?))
    }

    pub async fn enqueue(&mut self, batch: &Batch, loss: &LossTracker) -> Result<bool> {
        let (bytes, count) = self.usage().await?;
        if bytes.saturating_add(batch.payload.len() as u64) > self.max_bytes
            || count >= self.max_batches
        {
            self.record_loss(&batch.epoch, LossReason::BufferFull, batch.points, loss)
                .await?;
            return Ok(false);
        }
        sqlx::query("INSERT INTO batches (id, created_ns, epoch, points, payload) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(&batch.id).bind(i64::try_from(batch.created_ns)?).bind(&batch.epoch)
            .bind(i64::try_from(batch.points)?).bind(&batch.payload)
            .execute(self.connection()).await?;
        Ok(true)
    }

    pub async fn front(&mut self) -> Result<Option<Batch>> {
        sqlx::query("SELECT sequence, id, created_ns, epoch, points, payload FROM batches ORDER BY sequence LIMIT 1")
            .fetch_optional(self.connection()).await?
            .map(|row| Ok(Batch {
                sequence: row.try_get(0)?, id: row.try_get(1)?, created_ns: unsigned(&row, 2)?,
                epoch: row.try_get(3)?, points: unsigned(&row, 4)?, payload: row.try_get(5)?,
            })).transpose()
    }

    /// Deletion and any terminal-loss accounting commit in the same transaction.
    pub async fn finish(
        &mut self,
        batch: &Batch,
        discarded: Option<(LossReason, u64)>,
        loss: &LossTracker,
    ) -> Result<()> {
        let mut transaction = self.connection().begin().await?;
        let removed = sqlx::query("DELETE FROM batches WHERE sequence=?1 AND id=?2")
            .bind(batch.sequence)
            .bind(&batch.id)
            .execute(&mut *transaction)
            .await?;
        if removed.rows_affected() != 1 {
            return Err(io::Error::other("Pending batch disappeared").into());
        }
        if let Some((reason, points)) = discarded {
            add_loss(&mut transaction, reason, points).await?;
        }
        transaction.commit().await?;
        if let Some((reason, points)) = discarded {
            loss.record(&batch.epoch, reason, points);
        }
        Ok(())
    }

    pub async fn record_loss(
        &mut self,
        epoch: &str,
        reason: LossReason,
        points: u64,
        loss: &LossTracker,
    ) -> Result<()> {
        add_loss(self.connection(), reason, points).await?;
        loss.record(epoch, reason, points);
        Ok(())
    }

    pub async fn discarded_points(&mut self) -> Result<u64> {
        let points: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(points), 0) FROM losses")
            .fetch_one(self.connection())
            .await?;
        Ok(u64::try_from(points)?)
    }

    pub async fn close(mut self) -> Result<()> {
        self.close_connection().await
    }

    pub(crate) async fn close_connection(&mut self) -> Result<()> {
        self.shutdown().expect("Queue is open").await??;
        Ok(())
    }

    fn shutdown(&mut self) -> Option<tokio::sync::oneshot::Receiver<sqlx::Result<()>>> {
        let connection = self.connection.take()?;
        let lock = self.lock.take();
        let runtime = self.runtime.clone();
        let (closed, waiting) = tokio::sync::oneshot::channel();
        // SQLx drops its connection asynchronously. Keep ownership through worker
        // shutdown even if the caller cancels close or drops the Tokio runtime.
        // Queue queries remain async; cleanup must outlive its awaiting caller.
        std::thread::spawn(move || {
            let result = runtime.block_on(connection.close());
            drop(lock);
            let _ = closed.send(result);
        });
        Some(waiting)
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn unsigned(row: &SqliteRow, index: usize) -> Result<u64> {
    Ok(u64::try_from(row.try_get::<i64, _>(index)?)?)
}

async fn add_loss(
    connection: &mut SqliteConnection,
    reason: LossReason,
    points: u64,
) -> Result<()> {
    sqlx::query("INSERT INTO losses (reason, points) VALUES (?1, ?2)
        ON CONFLICT(reason) DO UPDATE SET points=MIN(9223372036854775807 - excluded.points, points) + excluded.points")
        .bind(reason.index() as i64).bind(i64::try_from(points)?)
        .execute(connection).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("recount-spool-{}", Uuid::now_v7())))
        }
        async fn open(&self, bytes: u64, count: u64) -> Spool {
            Spool::open(&self.0, "http://receiver", bytes, count)
                .await
                .unwrap()
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn batch() -> Batch {
        let mut batch =
            Batch::new("epoch".into(), ExportMetricsServiceRequest::default(), 3).unwrap();
        batch.payload = vec![10; 100];
        batch
    }

    #[tokio::test]
    async fn restart_preserves_order_identity_and_exact_payload() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let first = batch();
        let second = batch();
        {
            let mut spool = directory.open(1024, 4).await;
            assert!(spool.enqueue(&first, &loss).await.unwrap());
            assert!(spool.enqueue(&second, &loss).await.unwrap());
            spool.close().await.unwrap();
        }
        let mut spool = directory.open(1024, 4).await;
        let loaded = spool.front().await.unwrap().unwrap();
        assert_eq!(
            (loaded.id.as_str(), loaded.created_ns, &loaded.payload),
            (first.id.as_str(), first.created_ns, &first.payload)
        );
        assert_eq!(Uuid::try_parse(&loaded.id).unwrap().get_version_num(), 7);
        spool.finish(&loaded, None, &loss).await.unwrap();
        assert_eq!(spool.front().await.unwrap().unwrap().id, second.id);
        assert_eq!(loss.generation(), 0);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn queue_full_preserves_old_batches_and_persists_loss() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let first = batch();
        {
            let mut spool = directory.open(100, 2).await;
            assert!(spool.enqueue(&first, &loss).await.unwrap());
            assert!(!spool.enqueue(&batch(), &loss).await.unwrap());
            assert_eq!(spool.usage().await.unwrap(), (100, 1));
            assert_eq!(spool.front().await.unwrap().unwrap().id, first.id);
            spool.close().await.unwrap();
        }
        let mut spool = directory.open(100, 2).await;
        assert_eq!(spool.discarded_points().await.unwrap(), 3);
        assert_eq!(loss.generation(), 1);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn batch_count_limit_applies_to_small_payloads() {
        let directory = Directory::new();
        let mut spool = directory.open(1024, 1).await;
        let loss = LossTracker::default();
        assert!(spool.enqueue(&batch(), &loss).await.unwrap());
        assert!(!spool.enqueue(&batch(), &loss).await.unwrap());
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_removal_and_loss_are_recovered_together() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        {
            let mut spool = directory.open(1024, 4).await;
            spool.enqueue(&batch(), &loss).await.unwrap();
            let batch = spool.front().await.unwrap().unwrap();
            spool
                .finish(&batch, Some((LossReason::BufferExpired, 3)), &loss)
                .await
                .unwrap();
            spool.close().await.unwrap();
        }
        let mut spool = directory.open(1024, 4).await;
        assert!(spool.front().await.unwrap().is_none());
        assert_eq!(spool.discarded_points().await.unwrap(), 3);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_second_process_or_changed_destination_cannot_reuse_queue() {
        let directory = Directory::new();
        let spool = directory.open(1024, 4).await;
        assert!(
            Spool::open(&directory.0, "http://receiver", 1024, 4)
                .await
                .is_err()
        );
        spool.close().await.unwrap();
        assert!(
            Spool::open(&directory.0, "http://other", 1024, 4)
                .await
                .is_err()
        );
        directory.open(1024, 4).await.close().await.unwrap();
    }

    #[test]
    fn expiry_uses_original_creation_time() {
        let mut batch = batch();
        batch.created_ns = 100;
        assert!(!batch.expired(99, 10));
        assert!(!batch.expired(109, 10));
        assert!(batch.expired(110, 10));
    }

    #[tokio::test]
    async fn a_shared_directory_is_rejected_without_changing_permissions() {
        let directory = Directory::new();
        fs::create_dir(&directory.0).unwrap();
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            Spool::open(&directory.0, "receiver", 1024, 4)
                .await
                .is_err()
        );
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!directory.0.join("queue.sqlite3").exists());
    }

    #[tokio::test]
    async fn storage_full_returns_an_error_without_removing_committed_data() {
        let directory = Directory::new();
        let mut spool = directory.open(1024 * 1024, 4).await;
        let loss = LossTracker::default();
        let first = batch();
        spool.enqueue(&first, &loss).await.unwrap();
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(spool.connection())
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "PRAGMA max_page_count={pages}"
        )))
        .execute(spool.connection())
        .await
        .unwrap();
        let mut larger = batch();
        larger.payload = vec![1; 65536];
        assert!(spool.enqueue(&larger, &loss).await.is_err());
        assert_eq!(spool.front().await.unwrap().unwrap().id, first.id);
        assert_eq!(spool.usage().await.unwrap(), (100, 1));
        assert_eq!(spool.discarded_points().await.unwrap(), 0);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_transaction_does_not_remove_a_batch() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        {
            let mut spool = directory.open(1024, 4).await;
            spool.enqueue(&batch(), &loss).await.unwrap();
            let mut transaction = spool
                .connection()
                .begin_with("BEGIN IMMEDIATE")
                .await
                .unwrap();
            sqlx::query("DELETE FROM batches")
                .execute(&mut *transaction)
                .await
                .unwrap();
            add_loss(&mut transaction, LossReason::BufferExpired, 3)
                .await
                .unwrap();
            drop(transaction);
            spool.close().await.unwrap();
        }
        let mut spool = directory.open(1024, 4).await;
        assert_eq!(spool.usage().await.unwrap(), (100, 1));
        assert_eq!(spool.discarded_points().await.unwrap(), 0);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn failed_loss_accounting_rolls_back_terminal_removal() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let mut spool = directory.open(1024, 4).await;
        spool.enqueue(&batch(), &loss).await.unwrap();
        let pending = spool.front().await.unwrap().unwrap();
        assert!(
            spool
                .finish(&pending, Some((LossReason::BufferExpired, u64::MAX)), &loss)
                .await
                .is_err()
        );
        assert_eq!(spool.front().await.unwrap().unwrap().id, pending.id);
        assert_eq!(spool.discarded_points().await.unwrap(), 0);
        assert_eq!(loss.generation(), 0);
        spool.close().await.unwrap();
        let mut spool = directory.open(1024, 4).await;
        assert_eq!(spool.front().await.unwrap().unwrap().id, pending.id);
        assert_eq!(spool.discarded_points().await.unwrap(), 0);
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn canceled_open_retains_ownership_until_stalled_initialization_finishes() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let pending = batch();
        let mut spool = directory.open(1024, 4).await;
        spool.enqueue(&pending, &loss).await.unwrap();
        spool.close().await.unwrap();

        let mut blocker = SqliteConnectOptions::new()
            .filename(directory.0.join("queue.sqlite3"))
            .connect()
            .await
            .unwrap();
        let exclusive = blocker.begin_with("BEGIN EXCLUSIVE").await.unwrap();
        let (starting, ready) = tokio::sync::oneshot::channel();
        let starting = std::sync::Mutex::new(Some(starting));
        // This pragma requires the database lock during connect(), before Spool exists.
        let options = SqliteConnectOptions::new()
            .pragma("application_id", "0")
            .thread_name(move |id| {
                if let Some(starting) = starting.lock().unwrap().take() {
                    let _ = starting.send(());
                }
                format!("recount-stalled-sqlite-{id}")
            });
        let path = directory.0.clone();
        let opening = tokio::spawn(async move {
            Spool::open_with_options(&path, "http://receiver", 1024, 4, options).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        opening.abort();
        let Err(canceled) = opening.await else {
            panic!("Expected canceled initialization caller");
        };
        assert!(canceled.is_cancelled());

        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.0.join("queue.lock"))
            .unwrap();
        let retained = contender.try_lock().is_err();
        // Unstall startup even if the ownership assertion fails.
        exclusive.rollback().await.unwrap();
        blocker.close().await.unwrap();
        assert!(retained, "Canceled connect released queue ownership");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while contender.try_lock().is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        drop(contender);
        let mut spool = directory.open(1024, 4).await;
        let loaded = spool.front().await.unwrap().unwrap();
        assert_eq!(
            (loaded.id, loaded.created_ns, loaded.payload),
            (pending.id, pending.created_ns, pending.payload)
        );
        assert_eq!(spool.usage().await.unwrap(), (100, 1));
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn queue_ownership_outlives_canceled_database_work() {
        let directory = Directory::new();
        let mut spool = directory.open(1024, 4).await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let mut started = Some(started);
        spool
            .connection()
            .lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                if let Some(started) = started.take() {
                    let _ = started.send(());
                    let _ = blocked.recv_timeout(std::time::Duration::from_secs(5));
                }
                true
            });
        let mut query = Box::pin(sqlx::query("SELECT 1").execute(spool.connection()));
        tokio::select! {
            _ = ready => {},
            result = &mut query => panic!("Expected blocked database work, got {result:?}"),
        }
        drop(query);
        let closed = spool.shutdown().unwrap();
        drop(spool);
        let competing = Spool::open(&directory.0, "http://receiver", 1024, 4).await;
        // Release the injected stall even if the ownership assertion fails.
        release.send(()).unwrap();
        assert!(competing.is_err());
        closed.await.unwrap().unwrap();
        directory.open(1024, 4).await.close().await.unwrap();
    }

    #[tokio::test]
    async fn queue_keeps_its_durability_schema_and_disk_bounds() {
        let directory = Directory::new();
        let mut spool = directory.open(1024, 4).await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                .fetch_one(spool.connection())
                .await
                .unwrap(),
            "delete"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
                .fetch_one(spool.connection())
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA cache_size")
                .fetch_one(spool.connection())
                .await
                .unwrap(),
            -1024
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA temp_store")
                .fetch_one(spool.connection())
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(spool.connection())
                .await
                .unwrap(),
            1
        );
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(spool.connection())
            .await
            .unwrap();
        let page_cap: i64 = sqlx::query_scalar("PRAGMA max_page_count")
            .fetch_one(spool.connection())
            .await
            .unwrap();
        assert_eq!(page_cap, (1024 * 2 + 4 * 512 + 1024 * 1024) / page_size + 1);
        assert_eq!(
            fs::metadata(directory.0.join("queue.sqlite3"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        spool.close().await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_schema_is_rejected_without_conversion() {
        let directory = Directory::new();
        let mut spool = directory.open(1024, 4).await;
        sqlx::query("PRAGMA user_version=2")
            .execute(spool.connection())
            .await
            .unwrap();
        spool.close().await.unwrap();
        assert!(
            Spool::open(&directory.0, "http://receiver", 1024, 4)
                .await
                .is_err()
        );
        let mut connection = SqliteConnectOptions::new()
            .filename(directory.0.join("queue.sqlite3"))
            .connect()
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            2
        );
        connection.close().await.unwrap();
    }
}
