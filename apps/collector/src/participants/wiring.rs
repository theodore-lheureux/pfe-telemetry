use std::{io, os::unix::fs::MetadataExt, path::Path, time::Duration};

use tokio::{sync::watch, task::JoinSet};
use tonic::transport::Endpoint;
use uuid::Uuid;

use super::{Runtime, Scope, Settings};
use crate::{
    config::{Config, Visibility},
    enrollment::Authorization,
    spool::Result,
};

pub(crate) struct Setup(Option<Settings>);
pub(crate) struct Service(Option<Runtime>);

impl Setup {
    pub(crate) fn load(config: &Config) -> Result<Self> {
        let settings = if config.enrollment_url.is_some() {
            Some(
                config
                    .participants_config
                    .as_deref()
                    .map(Settings::load)
                    .transpose()?
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        Ok(Self(settings))
    }

    pub(crate) fn bind(
        self,
        config: &Config,
        node: Option<Uuid>,
        authorization: Option<&Authorization>,
        endpoint: Endpoint,
    ) -> Result<Service> {
        let Some(settings) = self.0 else {
            return Ok(Service(None));
        };
        let authorization = authorization
            .ok_or_else(|| io::Error::other("Execution discovery requires enrollment"))?;
        if !config.drain && std::fs::metadata("/proc/self")?.uid() != 0 {
            return Err(io::Error::other("Execution environment discovery requires root").into());
        }
        let namespace = config
            .process_namespace_id
            .clone()
            .or_else(|| matches!(config.visibility, Visibility::Host).then(|| "host".into()))
            .ok_or_else(|| {
                io::Error::other("Restricted visibility requires a process namespace ID")
            })?;
        Ok(Service(Some(Runtime {
            settings,
            scope: Scope {
                project: authorization
                    .project
                    .ok_or_else(|| io::Error::other("Missing enrolled project"))?
                    .to_string(),
                node: node
                    .ok_or_else(|| io::Error::other("Missing enrolled node"))?
                    .to_string(),
                host: crate::linux::host_id_or_machine_id(config.host_id.clone())?,
                boot: std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
                    .trim()
                    .into(),
                namespace,
            },
            endpoint,
            authorization: authorization.clone(),
            period: Duration::from_millis(config.interval_ms),
            drain: config.drain,
        })))
    }
}

impl Service {
    pub(crate) async fn run(self, directory: &Path, stopped: watch::Receiver<bool>) -> Result<()> {
        if let Some(runtime) = self.0 {
            super::run(runtime, &directory.join("participants"), stopped).await?;
        }
        Ok(())
    }

    pub(crate) fn spawn(
        self,
        tasks: &mut JoinSet<Result<()>>,
        directory: &Path,
        stopped: watch::Receiver<bool>,
    ) {
        if let Some(runtime) = self.0 {
            let directory = directory.join("participants");
            tasks.spawn(async move { super::run(runtime, &directory, stopped).await });
        }
    }
}
