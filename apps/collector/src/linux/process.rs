use std::io::{self, BufRead, BufReader};

use opentelemetry_proto::tonic::metrics::v1::{ResourceMetrics, number_data_point::Value};
use procfs::{ProcError, process::Process};
use recount_telemetry_validation::catalogue::{
    PROCESS_CPU_TIME as CPU_TIME, PROCESS_DISK_IO as DISK_IO,
    PROCESS_MEMORY_RSS as RESIDENT_MEMORY, READ_STATUS,
};
use recount_telemetry_validation::linux_adapter::{self as adapter, ProcessIdentity, Scope};

use super::Collector;
use crate::{
    diagnostics::ReadStatus,
    identity::same_incarnation,
    metrics::{counter, gauge, integer, resource, string},
};

impl Collector {
    pub(super) fn process_metrics(
        &mut self,
        process: &Process,
    ) -> io::Result<Result<ResourceMetrics, ReadStatus>> {
        let stat_result = process.stat();
        let cpu_time = self.clock.timestamp()?;
        let stat = match stat_result {
            Ok(stat) if stat.pid > 0 && stat.ppid >= 0 => stat,
            Ok(_) => return Ok(Err(ReadStatus::Failed)),
            Err(error) => return Ok(Err(ReadStatus::from_error(&error))),
        };
        let memory = process.statm();
        let memory_time = self.clock.timestamp()?;
        let disk = process.io();
        let disk_time = self.clock.timestamp()?;
        let uid = process
            .open_relative("status")
            .ok()
            .and_then(|file| real_uid(BufReader::new(file)));
        let job = process
            .open_relative("cgroup")
            .ok()
            .and_then(|file| slurm_job(BufReader::new(file)));
        // Do not create counter state or resource identity before this recheck.
        let recheck = process.stat();
        self.clock.timestamp()?;
        match recheck {
            Ok(current)
                if same_incarnation(stat.pid, stat.starttime, current.pid, current.starttime) => {}
            Ok(_) => return Ok(Err(ReadStatus::Failed)),
            Err(error) => return Ok(Err(ReadStatus::from_error(&error))),
        }
        let incarnation = ProcessIdentity {
            boot: &self.boot,
            namespace: &self.namespace,
            pid: stat.pid as u64,
            start_ticks: stat.starttime,
        }
        .incarnation();
        let prefix = format!("process/{incarnation}");
        let mut cpu_points = Vec::new();
        for (mode, ticks) in [("user", stat.utime), ("system", stat.stime)] {
            cpu_points.push(self.counter_point(
                format!("{prefix}/{}/{mode}", CPU_TIME.name),
                ticks,
                Value::AsDouble(ticks as f64 / self.ticks_per_second as f64),
                cpu_time,
                0,
                vec![string("cpu.mode", mode)],
            )?);
        }
        let mut metrics = vec![counter(&CPU_TIME, cpu_points)];
        let mut statuses = vec![self.read_status(&CPU_TIME, ReadStatus::Read, cpu_time)];
        let memory_status = match memory {
            Ok(memory) => match memory
                .resident
                .checked_mul(self.page_size)
                .and_then(|bytes| i64::try_from(bytes).ok())
            {
                Some(bytes) => {
                    metrics.push(self.int_gauge(&RESIDENT_MEMORY, bytes, memory_time));
                    ReadStatus::Read
                }
                None => ReadStatus::OutOfRange,
            },
            Err(error) => ReadStatus::from_error(&error),
        };
        statuses.push(self.read_status(&RESIDENT_MEMORY, memory_status, memory_time));
        let mut disk_points = Vec::new();
        let disk_status = match disk {
            Ok(disk) => {
                let mut status = ReadStatus::Read;
                for (direction, raw) in [("read", disk.read_bytes), ("write", disk.write_bytes)] {
                    match i64::try_from(raw) {
                        Ok(bytes) => disk_points.push(self.counter_point(
                            format!("{prefix}/{}/{direction}", DISK_IO.name),
                            raw,
                            Value::AsInt(bytes),
                            disk_time,
                            0,
                            vec![string("disk.io.direction", direction)],
                        )?),
                        Err(_) => status = ReadStatus::OutOfRange,
                    }
                }
                status
            }
            Err(error) => ReadStatus::from_error(&error),
        };
        if !disk_points.is_empty() {
            metrics.push(counter(&DISK_IO, disk_points));
        }
        statuses.push(self.read_status(&DISK_IO, disk_status, disk_time));
        metrics.push(gauge(&READ_STATUS, statuses));
        let mut attributes = self.attributes(Scope::Process);
        attributes.extend([
            integer(adapter::PID, i64::from(stat.pid)),
            integer(adapter::PARENT_PID, i64::from(stat.ppid)),
            string(adapter::NAMESPACE_ID, self.namespace.clone()),
            string(
                adapter::INCARNATION_ID,
                format!("start-ticks:{}", stat.starttime),
            ),
            string(adapter::START_TICKS, stat.starttime.to_string()),
            integer(adapter::CLOCK_TICKS, self.ticks_per_second as i64),
        ]);
        if let Some(uid) = uid {
            attributes.push(integer(adapter::REAL_USER_ID, i64::from(uid)));
        }
        if let Some((job, step)) = job {
            attributes.push(integer(adapter::SLURM_JOB_ID, i64::from(job)));
            if let Some(step) = step {
                attributes.push(integer(adapter::SLURM_STEP_ID, i64::from(step)));
            }
        }
        // Derived wall-clock start times are omitted: btime/tick precision alone
        // does not establish a truthful wall-clock resolution across steps.
        Ok(Ok(resource(attributes, metrics)))
    }
}

fn real_uid(status: impl BufRead) -> Option<u32> {
    for line in status.lines() {
        let line = line.ok()?;
        if let Some(ids) = line.strip_prefix("Uid:") {
            return ids.split_ascii_whitespace().next()?.parse().ok();
        }
    }
    None
}

fn numeric_scope(component: &str, prefix: &str) -> Option<u32> {
    let digits = component.strip_prefix(prefix)?;
    digits
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| digits.parse().ok())
        .flatten()
}

fn slurm_path(path: &str) -> Option<(u32, Option<u32>)> {
    let mut components = path.strip_prefix('/')?.split('/');
    components.find(|name| {
        *name == "slurm"
            || *name == "slurmstepd.scope"
            || name
                .strip_suffix("-slurmstepd.scope")
                .is_some_and(|prefix| !prefix.is_empty())
    })?;
    let mut job = components.next()?;
    if numeric_scope(job, "uid_").is_some() {
        job = components.next()?;
    }
    Some((
        numeric_scope(job, "job_")?,
        components
            .next()
            .and_then(|step| numeric_scope(step, "step_")),
    ))
}

fn slurm_job(cgroups: impl BufRead) -> Option<(u32, Option<u32>)> {
    let mut found = None;
    for line in cgroups.lines() {
        let line = line.ok()?;
        let Some((_, path)) = line
            .split_once(':')
            .and_then(|(_, rest)| rest.split_once(':'))
        else {
            continue;
        };
        let Some((job, step)) = slurm_path(path) else {
            continue;
        };
        match found {
            Some((previous, _)) if previous != job => return None,
            Some((_, Some(previous))) if step.is_some_and(|step| step != previous) => return None,
            Some((_, Some(_))) => {}
            _ => found = Some((job, step)),
        }
    }
    found
}

pub(super) fn discovered_entry(error: &ProcError) -> bool {
    let path = match error {
        ProcError::PermissionDenied(path)
        | ProcError::NotFound(path)
        | ProcError::Incomplete(path)
        | ProcError::Io(_, path) => path.as_ref(),
        _ => None,
    };
    path.and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .and_then(|name| name.parse::<i32>().ok())
        .is_some_and(|pid| pid > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_is_the_real_numeric_uid() {
        assert_eq!(
            real_uid(&b"Name:\tworker\nUid:\t1001\t0\t0\t0\n"[..]),
            Some(1001)
        );
        assert_eq!(real_uid(&b"Uid:\troot\t0\t0\t0\n"[..]), None);
        assert_eq!(real_uid(&b"Gid:\t1001\t0\t0\t0\n"[..]), None);
    }

    #[test]
    fn slurm_job_matches_scheduler_scopes_across_cgroup_versions() {
        for (input, expected) in [
            (
                "0::/system.slice/recount-slurmstepd.scope/job_42/step_7/user/task_0\n",
                Some((42, Some(7))),
            ),
            (
                "4:cpuset:/slurm/uid_1001/job_42/step_batch/nested\n",
                Some((42, None)),
            ),
            (
                "5:memory:/slurm/uid_1001/job_42\n4:cpuset:/slurm/uid_1001/job_42/step_7\n",
                Some((42, Some(7))),
            ),
            (
                "0::/system.slice/slurmstepd.scope/job_42/step_extern\n",
                Some((42, None)),
            ),
            ("0::/user.slice/job_42/step_7\n", None),
            ("0::/slurm/job_42extra/step_7\n", None),
            ("4:cpuset:/slurm/job_42\n5:memory:/slurm/job_43\n", None),
        ] {
            assert_eq!(slurm_job(input.as_bytes()), expected, "{input}");
        }
    }

    #[test]
    fn discovery_does_not_invent_entries_for_directory_errors() {
        assert!(!discovered_entry(&ProcError::Io(
            io::Error::from(io::ErrorKind::PermissionDenied),
            None,
        )));
        assert!(discovered_entry(&ProcError::NotFound(Some(
            "/proc/42".into()
        ))));
        assert!(!discovered_entry(&ProcError::NotFound(Some(
            "/proc".into()
        ))));
    }
}
