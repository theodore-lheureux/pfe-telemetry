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
use rusqlite::{Connection, OptionalExtension, params};
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
    connection: Connection,
    _lock: File,
    max_bytes: u64,
    max_batches: u64,
}

impl Spool {
    pub fn open(
        directory: &Path,
        destination: &str,
        max_bytes: u64,
        max_batches: u64,
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
        let connection = Connection::open(database)?;
        // DELETE avoids an ever-growing WAL. FULL syncs commits and the rollback
        // journal. The directory must reside on a local, reliable filesystem.
        connection.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            PRAGMA cache_size=-1024; PRAGMA temp_store=MEMORY;",
        )?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if !matches!(version, 0 | 1) {
            return Err(io::Error::other("Unsupported queue schema version").into());
        }
        connection.execute_batch(
            "BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS batches (
                sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                created_ns INTEGER NOT NULL, epoch TEXT NOT NULL,
                points INTEGER NOT NULL, payload BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS losses (reason INTEGER PRIMARY KEY, points INTEGER NOT NULL);
            PRAGMA user_version=1; COMMIT;",
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO settings VALUES ('destination', ?1)",
            [destination],
        )?;
        let stored: String = connection.query_row(
            "SELECT value FROM settings WHERE key='destination'",
            [],
            |row| row.get(0),
        )?;
        if stored != destination {
            return Err(io::Error::other(
                "Queue destination changed; use a separate queue directory",
            )
            .into());
        }
        // Bound physical database growth as well as queued payload. Leave room
        // for B-tree fragmentation, row metadata and three loss counters.
        let page_size: u64 =
            connection.query_row("PRAGMA page_size", [], |row| unsigned(row, 0))?;
        let disk_budget = max_bytes
            .checked_mul(2)
            .and_then(|bytes| {
                max_batches
                    .checked_mul(512)
                    .and_then(|rows| bytes.checked_add(rows))
            })
            .and_then(|bytes| bytes.checked_add(1024 * 1024))
            .ok_or_else(|| io::Error::other("Queue disk budget overflow"))?;
        connection.pragma_update(
            None,
            "max_page_count",
            i64::try_from(disk_budget / page_size + 1)?,
        )?;
        let queue = Self {
            connection,
            _lock: lock,
            max_bytes,
            max_batches,
        };
        let (bytes, count) = queue.usage()?;
        if bytes > max_bytes || count > max_batches {
            return Err(io::Error::other(
                "Existing queue exceeds configured limits; restore the previous limits",
            )
            .into());
        }
        Ok(queue)
    }

    pub fn usage(&self) -> Result<(u64, u64)> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(SUM(length(payload)), 0), COUNT(*) FROM batches",
            [],
            |row| Ok((unsigned(row, 0)?, unsigned(row, 1)?)),
        )?)
    }

    pub fn enqueue(&mut self, batch: &Batch, loss: &LossTracker) -> Result<bool> {
        let (bytes, count) = self.usage()?;
        if bytes.saturating_add(batch.payload.len() as u64) > self.max_bytes
            || count >= self.max_batches
        {
            self.record_loss(&batch.epoch, LossReason::BufferFull, batch.points, loss)?;
            return Ok(false);
        }
        self.connection.execute("INSERT INTO batches (id, created_ns, epoch, points, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![batch.id, i64::try_from(batch.created_ns)?, batch.epoch, i64::try_from(batch.points)?, batch.payload])?;
        Ok(true)
    }

    pub fn front(&self) -> Result<Option<Batch>> {
        Ok(self.connection.query_row("SELECT sequence, id, created_ns, epoch, points, payload FROM batches ORDER BY sequence LIMIT 1", [], |row| Ok(Batch {
            sequence: row.get(0)?, id: row.get(1)?, created_ns: unsigned(row, 2)?,
            epoch: row.get(3)?, points: unsigned(row, 4)?, payload: row.get(5)?,
        })).optional()?)
    }

    /// Deletion and any terminal-loss accounting commit in the same transaction.
    pub fn finish(
        &mut self,
        batch: &Batch,
        discarded: Option<(LossReason, u64)>,
        loss: &LossTracker,
    ) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let removed = transaction.execute(
            "DELETE FROM batches WHERE sequence=?1 AND id=?2",
            params![batch.sequence, batch.id],
        )?;
        if removed != 1 {
            return Err(io::Error::other("Pending batch disappeared").into());
        }
        if let Some((reason, points)) = discarded {
            add_loss(&transaction, reason, points)?;
        }
        transaction.commit()?;
        if let Some((reason, points)) = discarded {
            loss.record(&batch.epoch, reason, points);
        }
        Ok(())
    }

    pub fn record_loss(
        &mut self,
        epoch: &str,
        reason: LossReason,
        points: u64,
        loss: &LossTracker,
    ) -> Result<()> {
        add_loss(&self.connection, reason, points)?;
        loss.record(epoch, reason, points);
        Ok(())
    }

    pub fn discarded_points(&self) -> Result<u64> {
        Ok(self
            .connection
            .query_row("SELECT COALESCE(SUM(points), 0) FROM losses", [], |row| {
                unsigned(row, 0)
            })?)
    }
}

fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn add_loss(connection: &Connection, reason: LossReason, points: u64) -> Result<()> {
    connection.execute("INSERT INTO losses (reason, points) VALUES (?1, ?2)
        ON CONFLICT(reason) DO UPDATE SET points=MIN(9223372036854775807 - excluded.points, points) + excluded.points",
        params![reason.index() as i64, i64::try_from(points)?])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("pfe-spool-{}", Uuid::now_v7())))
        }
        fn open(&self, bytes: u64, count: u64) -> Spool {
            Spool::open(&self.0, "http://receiver", bytes, count).unwrap()
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

    #[test]
    fn restart_preserves_order_identity_and_exact_payload() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let first = batch();
        let second = batch();
        {
            let mut spool = directory.open(1024, 4);
            assert!(spool.enqueue(&first, &loss).unwrap());
            assert!(spool.enqueue(&second, &loss).unwrap());
        }
        let mut spool = directory.open(1024, 4);
        let loaded = spool.front().unwrap().unwrap();
        assert_eq!(
            (loaded.id.as_str(), loaded.created_ns, &loaded.payload),
            (first.id.as_str(), first.created_ns, &first.payload)
        );
        assert_eq!(Uuid::try_parse(&loaded.id).unwrap().get_version_num(), 7);
        spool.finish(&loaded, None, &loss).unwrap();
        assert_eq!(spool.front().unwrap().unwrap().id, second.id);
        assert_eq!(loss.generation(), 0);
    }

    #[test]
    fn queue_full_preserves_old_batches_and_persists_loss() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        let first = batch();
        {
            let mut spool = directory.open(100, 2);
            assert!(spool.enqueue(&first, &loss).unwrap());
            assert!(!spool.enqueue(&batch(), &loss).unwrap());
            assert_eq!(spool.usage().unwrap(), (100, 1));
            assert_eq!(spool.front().unwrap().unwrap().id, first.id);
        }
        assert_eq!(directory.open(100, 2).discarded_points().unwrap(), 3);
        assert_eq!(loss.generation(), 1);
    }

    #[test]
    fn batch_count_limit_applies_to_small_payloads() {
        let directory = Directory::new();
        let mut spool = directory.open(1024, 1);
        let loss = LossTracker::default();
        assert!(spool.enqueue(&batch(), &loss).unwrap());
        assert!(!spool.enqueue(&batch(), &loss).unwrap());
    }

    #[test]
    fn terminal_removal_and_loss_are_recovered_together() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        {
            let mut spool = directory.open(1024, 4);
            spool.enqueue(&batch(), &loss).unwrap();
            let batch = spool.front().unwrap().unwrap();
            spool
                .finish(&batch, Some((LossReason::BufferExpired, 3)), &loss)
                .unwrap();
        }
        let spool = directory.open(1024, 4);
        assert!(spool.front().unwrap().is_none());
        assert_eq!(spool.discarded_points().unwrap(), 3);
    }

    #[test]
    fn a_second_process_or_changed_destination_cannot_reuse_queue() {
        let directory = Directory::new();
        let spool = directory.open(1024, 4);
        assert!(Spool::open(&directory.0, "http://receiver", 1024, 4).is_err());
        drop(spool);
        assert!(Spool::open(&directory.0, "http://other", 1024, 4).is_err());
        directory.open(1024, 4);
    }

    #[test]
    fn expiry_uses_original_creation_time() {
        let mut batch = batch();
        batch.created_ns = 100;
        assert!(!batch.expired(99, 10));
        assert!(!batch.expired(109, 10));
        assert!(batch.expired(110, 10));
    }

    #[test]
    fn a_shared_directory_is_rejected_without_changing_permissions() {
        let directory = Directory::new();
        fs::create_dir(&directory.0).unwrap();
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Spool::open(&directory.0, "receiver", 1024, 4).is_err());
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!directory.0.join("queue.sqlite3").exists());
    }

    #[test]
    fn storage_full_returns_an_error_without_removing_committed_data() {
        let directory = Directory::new();
        let mut spool = directory.open(1024 * 1024, 4);
        let loss = LossTracker::default();
        let first = batch();
        spool.enqueue(&first, &loss).unwrap();
        let pages: i64 = spool
            .connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        spool
            .connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
        let mut larger = batch();
        larger.payload = vec![1; 65536];
        assert!(spool.enqueue(&larger, &loss).is_err());
        assert_eq!(spool.front().unwrap().unwrap().id, first.id);
        assert_eq!(spool.usage().unwrap(), (100, 1));
        assert_eq!(spool.discarded_points().unwrap(), 0);
    }

    #[test]
    fn interrupted_transaction_does_not_remove_a_batch() {
        let directory = Directory::new();
        let loss = LossTracker::default();
        {
            let mut spool = directory.open(1024, 4);
            spool.enqueue(&batch(), &loss).unwrap();
            spool
                .connection
                .execute_batch("BEGIN IMMEDIATE; DELETE FROM batches;")
                .unwrap();
        }
        assert_eq!(directory.open(1024, 4).usage().unwrap(), (100, 1));
    }
}
