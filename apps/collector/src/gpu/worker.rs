use std::{
    fs,
    sync::mpsc::{Receiver, SyncSender, sync_channel},
    thread,
    time::{Duration, Instant},
};

use super::{Frame, Request, process};
use crate::diagnostics::ReadStatus;
use recount_nvidia_dcgm::{Error, Session, Snapshot};

type Response = (u64, Instant, Frame);

pub(super) fn start(interval: Duration) -> (SyncSender<Request>, Receiver<Response>) {
    let (sender, requests) = sync_channel(1);
    let (responses, receiver) = sync_channel(1);
    let started = thread::Builder::new()
        .name("recount-dcgm".into())
        .spawn(move || {
            let mut session = None;
            let mut retry = Instant::now();
            let mut error = Error::Unavailable;
            let mut process_reader = None;
            let mut process_retry = Instant::now();
            let mut process_error = ReadStatus::Unsupported;
            while let Ok(request) = requests.recv() {
                let Request {
                    generation,
                    processes: context,
                } = request;
                let hardware = nvidia_present();
                if session.is_none() && Instant::now() >= retry {
                    match Session::open(interval) {
                        Ok(opened) => session = Some(opened),
                        Err(Error::Absent) => {
                            error = Error::Absent;
                            retry = Instant::now() + Duration::from_secs(30);
                        }
                        Err(failed) => {
                            error = failed;
                            retry = Instant::now() + Duration::from_secs(30);
                            tracing::warn!(
                                ?error,
                                "Optional DCGM collection unavailable; CPU collection continues"
                            );
                        }
                    }
                }
                let result = match &mut session {
                    Some(session) => session.sample(),
                    None => Err(error),
                };
                let completed_ns = crate::clock::read_clock_pair().ok().map(|(time, _)| time);
                let mut processes = process::Frame::default();
                if context.enabled {
                    if process_reader.is_none() && Instant::now() >= process_retry {
                        match process::Reader::open(generation) {
                            Ok(opened) => process_reader = Some(opened),
                            Err(error) => {
                                process_error = error;
                                process_retry = Instant::now() + Duration::from_secs(30);
                            }
                        }
                    }
                    processes = match &mut process_reader {
                        Some(reader) => match reader.sample(&context, generation, interval) {
                            Ok(frame) => frame,
                            Err(error) => {
                                process_reader = None;
                                process_error = error;
                                process_retry = Instant::now() + Duration::from_secs(30);
                                process::Frame {
                                    status: Some(error),
                                    ..Default::default()
                                }
                            }
                        },
                        None => process::Frame {
                            status: Some(process_error),
                            ..Default::default()
                        },
                    };
                } else if hardware {
                    processes.status = Some(ReadStatus::Unsupported);
                }
                if let Err(failed) = result
                    && session.is_some()
                {
                    error = failed;
                    session = None;
                    retry = Instant::now() + Duration::from_secs(30);
                }
                let empty = result.as_ref().is_ok_and(|snapshot| {
                    snapshot.devices.is_empty() && snapshot.discovery.is_ok()
                }) || matches!(result, Err(Error::Absent)) && !hardware;
                let empty = empty && !processes.present;
                let result = if empty {
                    Ok(Snapshot {
                        devices: vec![],
                        discovery: Ok(()),
                    })
                } else {
                    result
                };
                if empty {
                    processes.status = None;
                }
                if responses
                    .send((
                        generation,
                        Instant::now(),
                        Frame {
                            devices: result,
                            processes,
                            completed_ns,
                        },
                    ))
                    .is_err()
                    || empty
                {
                    break;
                }
            }
        });
    if let Err(error) = started {
        tracing::warn!(kind = ?error.kind(), "Cannot start optional DCGM acquisition worker");
    }
    (sender, receiver)
}

fn nvidia_present() -> bool {
    fs::read_dir("/proc/driver/nvidia/gpus").is_ok_and(|mut entries| entries.next().is_some())
        || std::path::Path::new("/dev/nvidiactl").exists()
        || fs::read_dir("/sys/bus/pci/devices").is_ok_and(|entries| {
            entries.take(4096).flatten().any(|entry| {
                fs::read_to_string(entry.path().join("vendor"))
                    .is_ok_and(|vendor| vendor.trim() == "0x10de")
                    && fs::read_to_string(entry.path().join("class"))
                        .is_ok_and(|class| class.trim().starts_with("0x03"))
            })
        })
}
