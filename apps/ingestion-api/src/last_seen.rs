use std::time::{Duration, SystemTime};

use deadpool_postgres::Pool;
use papaya::HashMap;
use uuid::Uuid;

use crate::Result;

const UPDATE: &str = "UPDATE ingestion.collector_node AS n
    SET last_seen_at = v.seen
    FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, seen)
    WHERE n.id = v.id AND n.revoked_at IS NULL
      AND (n.last_seen_at IS NULL OR n.last_seen_at < v.seen)";

#[derive(Default)]
pub(crate) struct LastSeen(HashMap<Uuid, SystemTime>);

impl LastSeen {
    pub(crate) fn record(&self, node: Uuid, seen: SystemTime) {
        self.0
            .pin()
            .update_or_insert(node, |latest| (*latest).max(seen), seen);
    }

    async fn flush_with(
        &self,
        write: impl AsyncFnOnce(Vec<Uuid>, Vec<SystemTime>) -> Result<()>,
    ) -> Result<()> {
        let (nodes, times): (Vec<_>, Vec<_>) = self
            .0
            .pin()
            .iter()
            .map(|(&node, &seen)| (node, seen))
            .unzip();
        if nodes.is_empty() {
            return Ok(());
        }
        write(nodes.clone(), times.clone()).await?;
        let pending = self.0.pin();
        for (node, seen) in nodes.into_iter().zip(times) {
            // An export can arrive while the snapshot is in flight.
            let _ = pending.remove_if(&node, |_, latest| *latest <= seen);
        }
        Ok(())
    }

    pub(crate) async fn flush(&self, pool: &Pool) -> Result<()> {
        tokio::time::timeout(
            Duration::from_secs(2),
            self.flush_with(async |nodes, times| {
                let mut client = pool.get().await?;
                let transaction = client.build_transaction().read_only(false).start().await?;
                transaction.execute(UPDATE, &[&nodes, &times]).await?;
                transaction.commit().await?;
                Ok(())
            }),
        )
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[tokio::test]
    async fn failed_batch_is_retried_and_newer_exports_survive_an_in_flight_write() {
        let pending = LastSeen::default();
        let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
        let newer = UNIX_EPOCH + Duration::from_secs(1);
        pending.record(a, newer);
        pending.record(a, UNIX_EPOCH);
        pending.record(b, UNIX_EPOCH);
        assert!(
            pending
                .flush_with(async |nodes, times| {
                    assert_eq!(nodes.len(), 2);
                    assert!(
                        nodes
                            .into_iter()
                            .zip(times)
                            .any(|entry| entry == (a, newer))
                    );
                    Err("database unavailable".into())
                })
                .await
                .is_err()
        );
        pending
            .flush_with(async |nodes, _| {
                assert_eq!(nodes.len(), 2);
                pending.record(b, newer);
                Ok(())
            })
            .await
            .unwrap();
        pending
            .flush_with(async |nodes, times| {
                assert_eq!(nodes, [b]);
                assert_eq!(times, [newer]);
                Ok(())
            })
            .await
            .unwrap();
        pending
            .flush_with(async |_, _| panic!("empty batch must not write"))
            .await
            .unwrap();
    }
}
