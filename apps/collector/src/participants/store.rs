use std::{collections::BTreeMap, io, path::Path};

use prost::Message;
use recount_telemetry_schema::wire::{ParticipantFact, ParticipantFactKind};
use sqlx::{Connection, Row};

use super::settings::Settings;
use crate::spool::{Result, Spool};

mod facts;
mod schema;
#[cfg(test)]
mod tests;

pub(super) struct Store {
    spool: Spool,
    max_facts: usize,
    max_queue_bytes: usize,
    heartbeat_interval_ns: u64,
}

pub(super) struct Pending {
    pub sequence: i64,
    pub payload: Vec<u8>,
}

impl Store {
    pub async fn open(directory: &Path, destination: &str, settings: &Settings) -> Result<Self> {
        settings.validate()?;
        let mut spool = Spool::open(
            directory,
            destination,
            settings.max_queue_bytes as u64,
            settings.max_facts as u64,
        )
        .await?;
        schema::initialize(spool.connection()).await?;
        Ok(Self {
            spool,
            max_facts: settings.max_facts,
            max_queue_bytes: settings.max_queue_bytes,
            heartbeat_interval_ns: settings.heartbeat_interval_seconds * 1_000_000_000,
        })
    }

    /// Local coverage may be newer than the immutable snapshot bearing this revision.
    pub async fn facts(&mut self) -> Result<Vec<ParticipantFact>> {
        self.snapshots(true).await
    }

    async fn snapshots(&mut self, include_observations: bool) -> Result<Vec<ParticipantFact>> {
        let rows =
            sqlx::query("SELECT payload,observed_last_seen FROM participant_facts ORDER BY id")
                .fetch_all(self.spool.connection())
                .await?;
        rows.into_iter()
            .map(|row| {
                let bytes: Vec<u8> = row.try_get(0)?;
                let mut fact = ParticipantFact::decode(bytes.as_slice())?;
                if include_observations {
                    let observed: Vec<u8> = row.try_get(1)?;
                    fact.last_seen_unix_nano = u64::from_be_bytes(observed.as_slice().try_into()?);
                }
                recount_telemetry_validation::execution::validate(&fact)?;
                Ok(fact)
            })
            .collect()
    }

    /// Revision allocation and immutable retry bytes commit in the same transaction.
    pub async fn commit(&mut self, changes: &[ParticipantFact]) -> Result<()> {
        let retained: BTreeMap<_, _> = self
            .snapshots(false)
            .await?
            .into_iter()
            .map(|f| (f.fact_id.clone(), f))
            .collect();
        let additions = changes
            .iter()
            .filter(|f| !retained.contains_key(&f.fact_id))
            .count();
        if additions > self.max_facts.saturating_sub(retained.len()) {
            return Err(io::Error::other("Participant fact budget exceeded").into());
        }
        let mut tx = self
            .spool
            .connection()
            .begin_with("BEGIN IMMEDIATE")
            .await?;
        for fact in changes {
            facts::write(
                &mut tx,
                retained.get(&fact.fact_id),
                fact,
                self.heartbeat_interval_ns,
            )
            .await?;
        }
        schema::check_bytes(&mut tx, self.max_queue_bytes).await?;
        schema::prune(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn front(&mut self) -> Result<Option<Pending>> {
        // Memberships stay blocked until an initial lifecycle publication is confirmed.
        let row = sqlx::query(
            "SELECT q.sequence,q.payload FROM participant_queue q
             JOIN participant_status p ON p.id=q.participant
             WHERE q.kind=? OR p.published=1 ORDER BY q.sequence LIMIT 1",
        )
        .bind(ParticipantFactKind::ParticipantLifecycle as i32)
        .fetch_optional(self.spool.connection())
        .await?;
        row.map(|row| {
            Ok(Pending {
                sequence: row.try_get(0)?,
                payload: row.try_get(1)?,
            })
        })
        .transpose()
    }

    pub async fn accept(&mut self, pending: &Pending) -> Result<()> {
        let fact = ParticipantFact::decode(pending.payload.as_slice())?;
        let mut tx = self.spool.connection().begin().await?;
        sqlx::query("DELETE FROM participant_queue WHERE sequence=?")
            .bind(pending.sequence)
            .execute(&mut *tx)
            .await?;
        if fact.kind == ParticipantFactKind::ParticipantLifecycle as i32 {
            sqlx::query("UPDATE participant_status SET published=1 WHERE id=?")
                .bind(&fact.fact_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE participant_facts SET acknowledged=1 WHERE id=? AND payload=?")
            .bind(&fact.fact_id)
            .bind(&pending.payload)
            .execute(&mut *tx)
            .await?;
        // Never mutate in-flight bytes. After their acknowledgement, enqueue the
        // latest replacement, subsuming intermediate unsent observations.
        sqlx::query(
            "INSERT INTO participant_queue (fact,participant,kind,payload)
             SELECT id,participant,kind,payload FROM participant_facts WHERE id=? AND payload<>?",
        )
        .bind(&fact.fact_id)
        .bind(&pending.payload)
        .execute(&mut *tx)
        .await?;
        schema::check_bytes(&mut tx, self.max_queue_bytes).await?;
        schema::prune(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn reject(&mut self, pending: &Pending, code: tonic::Code) -> Result<()> {
        let mut tx = self.spool.connection().begin().await?;
        sqlx::query("INSERT INTO participant_rejections VALUES (?,?,?)")
            .bind(pending.sequence)
            .bind(&pending.payload)
            .bind(code as i32)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM participant_queue WHERE sequence=?")
            .bind(pending.sequence)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::error!(
            ?code,
            sequence = pending.sequence,
            "Participant fact permanently rejected; retained, not retimed or retried"
        );
        Ok(())
    }

    pub async fn remaining(&mut self) -> Result<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM participant_queue")
            .fetch_one(self.spool.connection())
            .await?)
    }

    pub async fn close(self) -> Result<()> {
        self.spool.close().await
    }
}
