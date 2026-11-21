use std::collections::{BTreeMap, BTreeSet};

use recount_telemetry_schema::wire::{
    ParticipantFact, ParticipantFactKind, ParticipantOrigin, ParticipantProvenance,
    ParticipantSubject, ProcessIncarnation,
};

use super::{
    Scope,
    discovery::{Incarnation, Observation, Scan},
    store::Store,
};
use crate::spool::Result;

#[cfg(test)]
mod heartbeat_tests;
#[cfg(test)]
mod tests;

pub(super) struct Engine {
    scope: Scope,
    limit: usize,
    skipped: BTreeSet<Incarnation>,
}

impl Engine {
    pub fn new(scope: Scope, limit: usize) -> Self {
        Self {
            scope,
            limit,
            skipped: BTreeSet::new(),
        }
    }

    pub async fn scan(&mut self, store: &mut Store, scan: &Scan) -> Result<BTreeSet<(i32, u64)>> {
        let retained = store.facts().await?;
        let mut facts: BTreeMap<_, _> = retained
            .iter()
            .cloned()
            .map(|f| (f.fact_id.clone(), f))
            .collect();
        let mut members = BTreeSet::new();
        let mut lifecycles = BTreeMap::new();
        self.skipped.retain(|id| scan.processes.contains_key(id));
        for fact in facts
            .values_mut()
            .filter(|f| f.ended_unix_nano.is_none() && !f.retracted)
        {
            if let Some(process) = fact.subject.as_ref().and_then(|s| s.process.as_ref()) {
                let id = Incarnation {
                    pid: process.pid as i32,
                    ticks: process.start_time_ticks,
                };
                if fact.boot_id != self.scope.boot || process.namespace_id != self.scope.namespace {
                    end(fact, fact.last_seen_unix_nano)?;
                } else if let Some(observation) = scan.processes.get(&id) {
                    if observation.verified {
                        touch(fact, scan.time);
                    }
                    members.insert(id);
                } else {
                    end(fact, scan.time)?;
                }
            } else if fact.boot_id == self.scope.boot {
                lifecycles.insert(fact.execution_key.clone(), fact.fact_id.clone());
            } else {
                end(fact, fact.last_seen_unix_nano)?;
            }
        }
        let mut skipped = 0usize;
        for (id, observation) in &scan.processes {
            let Some(label) = &observation.label else {
                continue;
            };
            if members.contains(id) || self.skipped.contains(id) || !observation.verified {
                continue;
            }
            let needed = if lifecycles.contains_key(&label.key) {
                1
            } else {
                2
            };
            if needed > self.limit.saturating_sub(facts.len()) {
                self.skipped.insert(*id);
                skipped += 1;
                continue;
            }
            let participant = lifecycles
                .entry(label.key.clone())
                .or_insert_with(|| {
                    let id = uuid::Uuid::new_v4().to_string();
                    let lifecycle = self.fact(
                        &id,
                        &id,
                        observation,
                        scan.time,
                        ParticipantFactKind::ParticipantLifecycle,
                    );
                    facts.insert(id.clone(), lifecycle);
                    id
                })
                .clone();
            let fact_id = uuid::Uuid::new_v4().to_string();
            let mut fact = self.fact(
                &participant,
                &fact_id,
                observation,
                scan.time,
                ParticipantFactKind::ProcessMembership,
            );
            fact.subject = Some(ParticipantSubject {
                process: Some(ProcessIncarnation {
                    namespace_id: self.scope.namespace.clone(),
                    pid: id.pid as u32,
                    start_time_ticks: id.ticks,
                }),
            });
            facts.insert(fact_id, fact);
            members.insert(*id);
        }
        // Even cap-skipped labels keep an existing lifecycle alive.
        let mut alive_keys = BTreeMap::new();
        for observation in scan.processes.values() {
            if let Some(label) = &observation.label {
                *alive_keys.entry(label.key.as_str()).or_insert(false) |= observation.verified;
            }
        }
        for (key, id) in lifecycles {
            let fact = facts.get_mut(&id).expect("Retained lifecycle");
            match alive_keys.get(key.as_str()) {
                Some(true) => touch(fact, scan.time),
                Some(false) => {}
                None => end(fact, scan.time)?,
            }
        }
        let previous: BTreeMap<_, _> = retained.iter().map(|f| (f.fact_id.as_str(), f)).collect();
        let mut changes = Vec::new();
        for mut fact in facts.into_values() {
            if let Some(old) = previous.get(fact.fact_id.as_str()) {
                if **old == fact {
                    continue;
                }
                fact.revision = fact
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| std::io::Error::other("Participant revision exhausted"))?;
            }
            changes.push(fact);
        }
        // Parent rows must be written before membership snapshots.
        changes.sort_by_key(|f| f.kind);
        store.commit(&changes).await?;
        if skipped != 0 {
            tracing::warn!(
                skipped_processes = skipped,
                coverage = "unknown_incomplete",
                "Global fact cap reached; new associations skipped, retained facts continue updating"
            );
        }
        Ok(members
            .into_iter()
            .filter(|id| scan.processes[id].verified)
            .map(|id| (id.pid, id.ticks))
            .collect())
    }

    fn fact(
        &self,
        participant: &str,
        id: &str,
        observation: &Observation,
        time: u64,
        kind: ParticipantFactKind,
    ) -> ParticipantFact {
        let label = observation.label.as_ref().expect("Labelled observation");
        ParticipantFact {
            project_id: self.scope.project.clone(),
            node_id: self.scope.node.clone(),
            host_id: self.scope.host.clone(),
            boot_id: self.scope.boot.clone(),
            execution_key: label.key.clone(),
            participant_id: participant.into(),
            fact_id: id.into(),
            revision: 1,
            kind: kind as i32,
            provenance: Some(ParticipantProvenance {
                origin: ParticipantOrigin::Environment as i32,
                environment_variable: label.variable.clone(),
            }),
            owner_uid: observation.uid,
            first_seen_unix_nano: time,
            last_seen_unix_nano: time,
            metadata: if kind == ParticipantFactKind::ParticipantLifecycle {
                label.metadata.clone()
            } else {
                None
            },
            ..Default::default()
        }
    }
}

fn touch(fact: &mut ParticipantFact, time: u64) {
    fact.last_seen_unix_nano = fact.last_seen_unix_nano.max(time);
}

fn end(fact: &mut ParticipantFact, time: u64) -> Result<()> {
    fact.ended_unix_nano = Some(
        time.max(
            fact.last_seen_unix_nano
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("Participant timestamp exhausted"))?,
        ),
    );
    Ok(())
}
