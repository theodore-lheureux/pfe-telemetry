use std::io;

use prost::Message;
use recount_telemetry_schema::wire::{ParticipantFact, ParticipantFactKind};
use recount_telemetry_validation::execution;
use sqlx::SqliteConnection;

use crate::spool::Result;

pub(super) async fn write(
    connection: &mut SqliteConnection,
    previous: Option<&ParticipantFact>,
    fact: &ParticipantFact,
    heartbeat_interval_ns: u64,
) -> Result<()> {
    execution::validate(fact)?;
    // Use the actual analytical projection, including its encoded publication limit.
    execution::project(fact, &fact.fact_id, u64::MAX)?;
    if let Some(old) = previous {
        let mut identity = old.clone();
        identity.revision = fact.revision;
        identity.first_seen_unix_nano = fact.first_seen_unix_nano;
        identity.last_seen_unix_nano = fact.last_seen_unix_nano;
        identity.ended_unix_nano = fact.ended_unix_nano;
        identity.retracted = fact.retracted;
        if old.revision.checked_add(1) != Some(fact.revision) || identity != *fact {
            return Err(
                io::Error::other("Participant revision or immutable identity changed").into(),
            );
        }
        let mut heartbeat = old.clone();
        heartbeat.revision = fact.revision;
        heartbeat.last_seen_unix_nano = fact.last_seen_unix_nano;
        if fact.ended_unix_nano.is_none()
            && !fact.retracted
            && heartbeat == *fact
            && fact.last_seen_unix_nano >= old.last_seen_unix_nano
            && fact
                .last_seen_unix_nano
                .saturating_sub(old.last_seen_unix_nano)
                < heartbeat_interval_ns
        {
            // Keep durable observed coverage separate from immutable publication
            // snapshots: acknowledging an older snapshot must not queue a scan.
            sqlx::query("UPDATE participant_facts SET observed_last_seen=? WHERE id=?")
                .bind(fact.last_seen_unix_nano.to_be_bytes().to_vec())
                .bind(&fact.fact_id)
                .execute(connection)
                .await?;
            return Ok(());
        }
    } else if fact.revision != 1 {
        return Err(io::Error::other("New fact must start at revision 1").into());
    }
    if fact.kind == ParticipantFactKind::ParticipantLifecycle as i32 {
        sqlx::query("INSERT OR IGNORE INTO participant_status (id) VALUES (?)")
            .bind(&fact.fact_id)
            .execute(&mut *connection)
            .await?;
    }
    let payload = fact.encode_to_vec();
    sqlx::query("INSERT INTO participant_facts (id,participant,kind,payload,observed_last_seen,terminal,retracted) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,observed_last_seen=excluded.observed_last_seen,terminal=excluded.terminal,retracted=excluded.retracted,acknowledged=0")
        .bind(&fact.fact_id).bind(&fact.participant_id).bind(fact.kind).bind(&payload)
        .bind(fact.last_seen_unix_nano.to_be_bytes().to_vec())
        .bind(fact.ended_unix_nano.is_some()).bind(fact.retracted)
        .execute(&mut *connection).await?;
    sqlx::query("INSERT INTO participant_queue (fact,participant,kind,payload) VALUES (?,?,?,?) ON CONFLICT(fact) DO NOTHING")
        .bind(&fact.fact_id).bind(&fact.participant_id).bind(fact.kind).bind(payload)
        .execute(connection).await?;
    Ok(())
}
