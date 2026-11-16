#[cfg(test)]
mod a10;
mod export;
mod mapping;
mod process;
#[cfg(test)]
mod tests;
mod worker;

use std::{
    collections::BTreeMap,
    sync::mpsc::{Receiver, SyncSender, TryRecvError},
    time::{Duration, Instant},
};

use opentelemetry_proto::tonic::metrics::v1::ResourceMetrics;
pub(crate) use process::{Context as ProcessContext, context as process_context};
use recount_nvidia_dcgm::{Device, Error, Field, Snapshot};

struct Request {
    generation: u64,
    processes: ProcessContext,
}

struct Frame {
    devices: Result<Snapshot, Error>,
    processes: process::Frame,
}

pub(crate) fn read_status(error: Error) -> crate::diagnostics::ReadStatus {
    mapping::status(error)
}

pub(crate) struct Gpu {
    requests: SyncSender<Request>,
    responses: Receiver<(u64, Instant, Frame)>,
    pending: bool,
    generation: u64,
    disabled: bool,
    interval: Duration,
    next_request: Instant,
    last_response: Instant,
    seen: BTreeMap<(String, Field), u64>,
    known: Vec<Device>,
    pub(crate) discovery: Option<Error>,
    processes: Vec<process::Reading>,
    pub(crate) process_status: Option<crate::diagnostics::ReadStatus>,
}

impl Gpu {
    pub(crate) fn new(interval: Duration) -> Self {
        let (requests, responses) = worker::start(interval);
        Self {
            requests,
            responses,
            pending: false,
            generation: 0,
            disabled: false,
            interval,
            next_request: Instant::now(),
            last_response: Instant::now(),
            seen: BTreeMap::new(),
            known: vec![],
            discovery: None,
            processes: vec![],
            process_status: None,
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.seen.clear();
        self.known.clear();
        self.discovery = None;
        self.processes.clear();
        self.process_status = None;
        self.last_response = Instant::now();
    }

    pub(crate) fn has_devices(&self) -> bool {
        !self.known.is_empty()
    }

    /// Never waits on a native driver call. One request and one response suffice;
    /// a hung optional worker cannot block procfs acquisition or Tokio shutdown.
    pub(crate) fn sample(
        &mut self,
        attrs: Vec<opentelemetry_proto::tonic::common::v1::KeyValue>,
        now: u64,
        context: impl FnOnce() -> ProcessContext,
    ) -> Vec<ResourceMetrics> {
        let result = match self.responses.try_recv() {
            Ok((generation, completed, result)) => {
                self.pending = false;
                if generation == self.generation
                    && completed.elapsed() <= self.interval.max(Duration::from_secs(1)) * 3
                {
                    Some(result)
                } else {
                    None
                }
            }
            Err(TryRecvError::Disconnected) => {
                self.disabled = true;
                None
            }
            Err(TryRecvError::Empty) => None,
        };
        if !self.pending && !self.disabled && Instant::now() >= self.next_request {
            self.pending = self
                .requests
                .try_send(Request {
                    generation: self.generation,
                    processes: context(),
                })
                .is_ok();
            self.next_request = Instant::now() + self.interval.max(Duration::from_secs(1));
        }
        let result = result.map(|frame| {
            self.process_status = frame.processes.status;
            self.processes = frame.processes.readings;
            frame.devices
        });
        match result {
            Some(Ok(snapshot)) => {
                self.last_response = Instant::now();
                self.discovery = snapshot.discovery.err();
                self.known = snapshot.devices;
                let uuids: Vec<_> = self.known.iter().map(|d| d.uuid.as_str()).collect();
                self.seen
                    .retain(|(uuid, _), _| uuids.contains(&uuid.as_str()));
                export::resources(&self.known, &mut self.seen, attrs, now, self.interval)
            }
            Some(Err(error)) => {
                self.last_response = Instant::now();
                self.discovery = Some(error);
                for device in &mut self.known {
                    for reading in &mut device.readings {
                        reading.value = Err(error);
                    }
                }
                export::resources(&self.known, &mut self.seen, attrs, now, self.interval)
            }
            None if !self.known.is_empty()
                && self.last_response.elapsed() > self.interval.max(Duration::from_secs(1)) * 3 =>
            {
                let mut unavailable = self.known.clone();
                for device in &mut unavailable {
                    for reading in &mut device.readings {
                        reading.value = Err(Error::Unavailable);
                    }
                }
                export::resources(&unavailable, &mut self.seen, attrs, now, self.interval)
            }
            None => vec![],
        }
    }

    pub(crate) fn attach_processes(
        &mut self,
        resources: &[ResourceMetrics],
        now: u64,
    ) -> Vec<ResourceMetrics> {
        process::attach(
            resources,
            std::mem::take(&mut self.processes),
            now,
            self.interval,
        )
    }
}
