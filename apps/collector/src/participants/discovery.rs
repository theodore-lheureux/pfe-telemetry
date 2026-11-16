use std::{
    collections::BTreeMap,
    fs::{self, ReadDir},
    path::PathBuf,
    time::Instant,
};

use procfs::{ProcError, process::Process};
use recount_telemetry_schema::wire::ParticipantFact;

use super::{
    Scope,
    environment::{self, Label},
    settings::Settings,
};
use crate::spool::{Result, unix_nanos};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Incarnation {
    pub pid: i32,
    pub ticks: u64,
}

#[derive(Clone)]
pub(super) struct Observation {
    pub label: Option<Label>,
    pub uid: Option<u32>,
    pub verified: bool,
}

pub(super) struct Scan {
    pub time: u64,
    pub processes: BTreeMap<Incarnation, Observation>,
}

pub(super) struct Discovery {
    root: PathBuf,
    settings: Settings,
    cache: BTreeMap<Incarnation, Observation>,
    entries: Option<ReadDir>,
}

impl Discovery {
    pub fn new(scope: &Scope, settings: Settings, facts: &[ParticipantFact]) -> Result<Self> {
        let mut cache = BTreeMap::new();
        for fact in facts
            .iter()
            .filter(|f| f.boot_id == scope.boot && f.ended_unix_nano.is_none() && !f.retracted)
        {
            let Some(process) = fact
                .subject
                .as_ref()
                .and_then(|s| s.process.as_ref())
                .filter(|p| p.namespace_id == scope.namespace)
            else {
                continue;
            };
            cache.insert(
                Incarnation {
                    pid: process.pid as i32,
                    ticks: process.start_time_ticks,
                },
                Observation {
                    label: Some(Label {
                        key: fact.execution_key.clone(),
                        variable: fact
                            .provenance
                            .as_ref()
                            .expect("Validated stored provenance")
                            .environment_variable
                            .clone(),
                        metadata: None,
                    }),
                    uid: fact.owner_uid,
                    verified: false,
                },
            );
        }
        if cache.len() > settings.max_processes {
            return Err(std::io::Error::other(
                "Retained memberships exceed configured process cache limit",
            )
            .into());
        }
        Ok(Self {
            root: "/proc".into(),
            settings,
            cache,
            entries: None,
        })
    }

    pub fn scan(&mut self) -> Result<Scan> {
        let started = Instant::now();
        let mut unknown = 0usize;
        self.cache.retain(|id, observation| {
            observation.verified = false;
            match Process::new_with_root(self.root.join(id.pid.to_string())).and_then(|p| p.stat())
            {
                Ok(stat) if stat.pid == id.pid && stat.starttime == id.ticks => {
                    observation.verified = true;
                    true
                }
                Ok(_) | Err(ProcError::NotFound(_)) => false,
                Err(_) => {
                    unknown += 1;
                    true
                }
            }
        });
        let mut reads = 0usize;
        let mut entries = 0usize;
        let mut capped = 0usize;
        let mut candidates = Vec::new();
        if self.entries.is_none() {
            self.entries = fs::read_dir(&self.root).ok();
        }
        for _ in 0..self.settings.max_processes {
            let Some(entry) = self.entries.as_mut().and_then(Iterator::next) else {
                self.entries = None;
                break;
            };
            entries += 1;
            let Ok(entry) = entry else {
                unknown += 1;
                continue;
            };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<i32>().ok())
                .filter(|p| *p > 0)
            else {
                continue;
            };
            let Ok(process) = Process::new_with_root(self.root.join(pid.to_string())) else {
                continue;
            };
            let Ok(stat) = process.stat() else {
                unknown += 1;
                continue;
            };
            if stat.pid != pid {
                continue;
            }
            let id = Incarnation {
                pid,
                ticks: stat.starttime,
            };
            if self.cache.contains_key(&id) {
                continue;
            }
            candidates.push((id, stat.ppid));
        }
        // Proc-directory order can place children first, especially after PID wrap-around.
        candidates.sort_by_key(|(id, _)| id.ticks);
        for (id, parent_pid) in candidates {
            // No read takes place without space to retain its once-only decision.
            if self.cache.len() >= self.settings.max_processes {
                capped += 1;
                continue;
            }
            let path = self.root.join(id.pid.to_string());
            let Ok(process) = Process::new_with_root(path.clone()) else {
                continue;
            };
            reads += 1;
            let observation = self.observe(&process, id, parent_pid, || {
                match fs::File::open(path.join("environ")) {
                    Ok(file) => environment::read(file, &self.settings.scheduler_variables),
                    Err(_) => Ok(None),
                }
            });
            self.cache.insert(id, observation);
        }
        if capped != 0 {
            tracing::warn!(
                skipped = capped,
                "Process decision cache full; new environment reads skipped"
            );
        }
        tracing::debug!(
            entries,
            environment_reads = reads,
            identity_unknown = unknown,
            cached_processes = self.cache.len(),
            scan_micros = started.elapsed().as_micros(),
            "Execution environment discovery completed"
        );
        Ok(Scan {
            time: unix_nanos()?,
            processes: self.cache.clone(),
        })
    }

    fn observe(
        &self,
        process: &Process,
        id: Incarnation,
        parent_pid: i32,
        read: impl FnOnce() -> std::result::Result<Option<Label>, ()>,
    ) -> Observation {
        let decision = read();
        let uid = process.uid().ok();
        let label = match decision {
            Ok(Some(label)) => Some(label),
            Ok(None) => self.inherited_label(parent_pid, id, uid),
            Err(()) => None,
        };
        let stable = process.stat().is_ok_and(|current| {
            current.pid == id.pid && current.starttime == id.ticks && current.ppid == parent_pid
        });
        Observation {
            label: label.filter(|_| stable),
            uid: uid.filter(|_| stable),
            verified: stable,
        }
    }

    fn inherited_label(
        &self,
        parent_pid: i32,
        child: Incarnation,
        uid: Option<u32>,
    ) -> Option<Label> {
        let uid = uid?;
        let parent = Process::new_with_root(self.root.join(parent_pid.to_string())).ok()?;
        let stat = parent.stat().ok()?;
        if stat.pid != parent_pid || stat.starttime > child.ticks || parent.uid().ok()? != uid {
            return None;
        }
        let observation = self.cache.get(&Incarnation {
            pid: parent_pid,
            ticks: stat.starttime,
        })?;
        if !observation.verified || observation.uid != Some(uid) {
            return None;
        }
        observation.label.clone()
    }
}

#[cfg(test)]
mod budget_tests;
#[cfg(test)]
mod inheritance_tests;
#[cfg(test)]
mod tests;
