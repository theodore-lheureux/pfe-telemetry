use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use serde::Deserialize;

use crate::spool::Result;

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Settings {
    pub scheduler_variables: BTreeMap<String, String>,
    pub max_processes: usize,
    pub max_facts: usize,
    pub max_queue_bytes: usize,
    pub max_exports: usize,
    pub heartbeat_interval_seconds: u64,
    pub profile_executions: BTreeSet<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scheduler_variables: BTreeMap::from([("SLURM_JOB_ID".into(), "slurm".into())]),
            max_processes: 65_536,
            max_facts: 262_144,
            max_queue_bytes: 64 * 1024 * 1024,
            max_exports: 16,
            heartbeat_interval_seconds: 60,
            profile_executions: BTreeSet::new(),
        }
    }
}

impl Settings {
    pub fn load(filename: &Path) -> Result<Self> {
        let filename = std::path::absolute(filename)?;
        for ancestor in filename.ancestors() {
            let metadata = fs::symlink_metadata(ancestor)?;
            if metadata.file_type().is_symlink()
                || metadata.uid() != 0
                || metadata.mode() & 0o022 != 0
            {
                return Err(io::Error::other("Participant configuration and ancestors must be root-owned, not writable by group/other, and not symlinks").into());
            }
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&filename)?;
        check_file(&file)?;
        let mut contents = Vec::new();
        (&mut file).take(65_537).read_to_end(&mut contents)?;
        if contents.len() > 65_536 {
            return Err(io::Error::other("Participant configuration exceeds 65536 bytes").into());
        }
        let settings: Self = serde_json::from_slice(&contents)?;
        settings.validate()?;
        Ok(settings)
    }

    pub fn validate(&self) -> Result<()> {
        if self.scheduler_variables.len() > 32
            || self.profile_executions.len() > 64
            || self
                .profile_executions
                .iter()
                .any(|key| recount_telemetry_validation::execution::execution_key(key).is_err())
            || !(1..=1_000_000).contains(&self.max_processes)
            || !(2..=1_000_000).contains(&self.max_facts)
            || !(65_536..=1_073_741_824).contains(&self.max_queue_bytes)
            || !(1..=64).contains(&self.max_exports)
            || !(1..=u64::MAX / 1_000_000_000).contains(&self.heartbeat_interval_seconds)
            || self.scheduler_variables.iter().any(|(name, prefix)| {
                !variable_name(name)
                    || name.starts_with("RECOUNT_EXECUTION")
                    || recount_telemetry_validation::execution::execution_key(&format!(
                        "{prefix}:1"
                    ))
                    .is_err()
            })
        {
            return Err(io::Error::other("Invalid participant configuration").into());
        }
        Ok(())
    }
}

fn check_file(file: &File) -> Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::other(
            "Participant configuration must be a root-owned regular file",
        )
        .into());
    }
    Ok(())
}

fn variable_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_validate_scheduler_names_prefixes_and_bounds() {
        assert!(Settings::default().validate().is_ok());
        for name in ["", "1JOB", "JOB-ID", "RECOUNT_EXECUTION", &"X".repeat(129)] {
            let settings = Settings {
                scheduler_variables: BTreeMap::from([(name.into(), "jobs".into())]),
                ..Default::default()
            };
            assert!(settings.validate().is_err());
        }
        for prefix in ["", " bad", "é", &"x".repeat(128)] {
            let settings = Settings {
                scheduler_variables: BTreeMap::from([("PBS_JOBID".into(), prefix.into())]),
                ..Default::default()
            };
            assert!(settings.validate().is_err());
        }
    }

    #[test]
    fn heartbeat_defaults_to_sixty_seconds_and_must_fit_positive_nanoseconds() {
        let defaults: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults.heartbeat_interval_seconds, 60);
        let configured: Settings =
            serde_json::from_str(r#"{"heartbeat_interval_seconds":5}"#).unwrap();
        assert_eq!(configured.heartbeat_interval_seconds, 5);
        assert!(configured.validate().is_ok());
        for seconds in [0, u64::MAX / 1_000_000_000 + 1] {
            let settings = Settings {
                heartbeat_interval_seconds: seconds,
                ..Default::default()
            };
            assert!(settings.validate().is_err());
        }
    }
}
