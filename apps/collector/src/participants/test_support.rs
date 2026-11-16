use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use super::{
    Scope,
    discovery::{Incarnation, Observation, Scan},
    engine::Engine,
    environment::Label,
    settings::Settings,
    store::Store,
};

pub(super) struct Fixture {
    pub path: PathBuf,
    pub scope: Scope,
    pub settings: Settings,
}

impl Fixture {
    pub fn new() -> Self {
        Self {
            path: std::env::temp_dir()
                .join(format!("recount-environment-{}", uuid::Uuid::new_v4())),
            scope: Scope {
                project: uuid::Uuid::new_v4().to_string(),
                node: uuid::Uuid::new_v4().to_string(),
                host: "fixture-host".into(),
                boot: uuid::Uuid::new_v4().to_string(),
                namespace: "fixture-namespace".into(),
            },
            settings: Settings::default(),
        }
    }

    pub async fn open(&self) -> Store {
        Store::open(
            &self.path.join("queue"),
            "fixture-destination",
            &self.settings,
        )
        .await
        .unwrap()
    }

    pub fn engine(&self) -> Engine {
        Engine::new(self.scope.clone(), self.settings.max_facts)
    }

    pub fn proc_root(&self) -> PathBuf {
        let path = self.path.join("proc");
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    pub fn process(&self, pid: i32, ticks: u64, environment: &[u8]) {
        let root = self.proc_root().join(pid.to_string());
        std::fs::create_dir_all(&root).unwrap();
        stat(&root.join("stat"), pid, ticks);
        std::fs::write(root.join("environ"), environment).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub(super) fn stat(path: &std::path::Path, pid: i32, ticks: u64) {
    stat_with_parent(path, pid, ticks, 0);
}

pub(super) fn stat_with_parent(path: &std::path::Path, pid: i32, ticks: u64, parent: i32) {
    let mut fields = vec!["0".to_owned(); 50];
    fields[0] = "S".into();
    fields[1] = parent.to_string();
    fields[19] = ticks.to_string();
    std::fs::write(path, format!("{pid} (fixture) {}", fields.join(" "))).unwrap();
}

pub(super) fn scan(time: u64, processes: &[(i32, u64, &str)]) -> Scan {
    Scan {
        time,
        processes: processes
            .iter()
            .map(|(pid, ticks, key)| {
                (
                    Incarnation {
                        pid: *pid,
                        ticks: *ticks,
                    },
                    Observation {
                        label: Some(Label {
                            key: (*key).into(),
                            variable: "RECOUNT_EXECUTION".into(),
                            metadata: None,
                        }),
                        uid: Some(1000),
                        verified: true,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>(),
    }
}

pub(super) async fn acknowledge(store: &mut Store) {
    while let Some(pending) = store.front().await.unwrap() {
        store.accept(&pending).await.unwrap();
    }
}

#[derive(Clone, Default)]
pub(super) struct Logs(pub Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}
