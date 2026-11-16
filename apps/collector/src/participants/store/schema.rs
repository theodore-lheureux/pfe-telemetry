use std::io;

use sqlx::SqliteConnection;

use crate::spool::Result;

pub(super) async fn initialize(connection: &mut SqliteConnection) -> Result<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS participant_facts (
            id TEXT PRIMARY KEY, participant TEXT NOT NULL, kind INTEGER NOT NULL,
            payload BLOB NOT NULL, observed_last_seen BLOB NOT NULL,
            terminal INTEGER NOT NULL, retracted INTEGER NOT NULL,
            acknowledged INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS participant_status (
            id TEXT PRIMARY KEY, published INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS participant_queue (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL UNIQUE,
            participant TEXT NOT NULL, kind INTEGER NOT NULL, payload BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS participant_rejections (
            sequence INTEGER PRIMARY KEY, payload BLOB NOT NULL, code INTEGER NOT NULL);",
    )
    .execute(&mut *connection)
    .await?;
    sqlx::query("SELECT retracted,acknowledged,observed_last_seen FROM participant_facts LIMIT 0")
        .execute(connection)
        .await?;
    Ok(())
}

pub(super) async fn check_bytes(connection: &mut SqliteConnection, maximum: usize) -> Result<()> {
    let bytes: i64 = sqlx::query_scalar(
        "SELECT (SELECT COALESCE(SUM(length(payload)),0) FROM participant_queue)
              + (SELECT COALESCE(SUM(length(payload)),0) FROM participant_rejections)",
    )
    .fetch_one(connection)
    .await?;
    if bytes as usize > maximum {
        return Err(
            io::Error::other("Participant queue is full; no retained facts were evicted").into(),
        );
    }
    Ok(())
}

pub(super) async fn prune(connection: &mut SqliteConnection) -> Result<()> {
    sqlx::query(
        "DELETE FROM participant_facts WHERE terminal=1 AND acknowledged=1 AND retracted=0
         AND NOT EXISTS (SELECT 1 FROM participant_queue q WHERE q.fact=participant_facts.id)",
    )
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "DELETE FROM participant_status
         WHERE NOT EXISTS (SELECT 1 FROM participant_facts f WHERE f.participant=participant_status.id)
         AND NOT EXISTS (SELECT 1 FROM participant_queue q WHERE q.participant=participant_status.id)",
    ).execute(connection).await?;
    Ok(())
}
