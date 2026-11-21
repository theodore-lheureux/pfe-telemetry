use std::{
    io,
    os::fd::AsRawFd,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

use nix::{
    errno::Errno,
    libc,
    sys::socket::{
        AddressFamily, MsgFlags, NetlinkAddr, SockFlag, SockProtocol, SockType, recvfrom, sendto,
        socket,
    },
};
use opentelemetry_proto::tonic::metrics::v1::{Metric, number_data_point::Value};
use recount_telemetry_validation::catalogue;

use crate::{
    clock::read_clock_pair,
    diagnostics::ReadStatus,
    metrics::{Distribution, gauge, histogram, point},
};

pub(super) const PERIOD: Duration = Duration::from_secs(10);
const DEADLINE: Duration = Duration::from_millis(50);
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOCKETS: usize = 4096;
const SOCK_DIAG_BY_FAMILY: u16 = 20;
const INET_DIAG_INFO: u16 = 2;

type Frame = (u64, u64, Result<Distribution, ReadStatus>);

pub(super) struct Worker {
    request: SyncSender<u64>,
    response: Receiver<Frame>,
    cancelled: Arc<AtomicBool>,
    next: Instant,
    generation: u64,
    pending: bool,
}

impl Worker {
    pub(super) fn start() -> io::Result<Self> {
        let (request, requests) = sync_channel(1);
        let (responses, response) = sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        thread::Builder::new()
            .name("recount-tcp-rtt".into())
            .spawn(move || {
                while let Ok(generation) = requests.recv() {
                    let result = sweep(&stop);
                    let Ok((time, _)) = read_clock_pair() else {
                        break;
                    };
                    if responses.send((generation, time, result)).is_err() {
                        break;
                    }
                }
            })?;
        Ok(Self {
            request,
            response,
            cancelled,
            next: Instant::now(),
            generation: 0,
            pending: false,
        })
    }

    pub(super) fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.next = Instant::now();
    }

    pub(super) fn sample(&mut self, now: u64) -> Vec<Metric> {
        let mut metrics = Vec::new();
        if let Ok((generation, time, result)) = self.response.try_recv() {
            self.pending = false;
            if generation == self.generation && now.saturating_sub(time) < PERIOD.as_nanos() as u64
            {
                let status = match result {
                    Ok(distribution) => {
                        metrics.push(gauge(
                            &catalogue::TCP_RTT_COVERAGE,
                            vec![point(
                                Value::AsInt(distribution.count() as i64),
                                time,
                                0,
                                vec![],
                            )],
                        ));
                        if let Some(p) = distribution.finish(time, vec![]) {
                            metrics.push(histogram(&catalogue::NODE_TCP_RTT_DISTRIBUTION, vec![p]));
                        }
                        ReadStatus::Read
                    }
                    Err(status) => {
                        self.next = Instant::now() + PERIOD * 3;
                        status
                    }
                };
                metrics.push(gauge(
                    &catalogue::TCP_RTT_STATUS,
                    vec![point(Value::AsInt(status as i64), time, 0, vec![])],
                ));
            }
        }
        if !self.pending && Instant::now() >= self.next {
            self.pending = self.request.try_send(self.generation).is_ok();
            self.next = Instant::now() + PERIOD;
        }
        metrics
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

fn sweep(cancelled: &AtomicBool) -> Result<Distribution, ReadStatus> {
    let deadline = Instant::now() + DEADLINE;
    let fd = socket(
        AddressFamily::Netlink,
        SockType::Raw,
        SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
        SockProtocol::NetlinkSockDiag,
    )
    .map_err(status)?;
    let mut budget = Budget {
        bytes: 0,
        sockets: 0,
    };
    let mut buffer = vec![0; 64 * 1024];
    let mut dist = Distribution::new(vec![
        0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0,
    ]);
    for (seq, family) in [(1, libc::AF_INET), (2, libc::AF_INET6)] {
        let request = request(seq, family as u8);
        let fd = fd.as_raw_fd();
        sendto(fd, &request, &NetlinkAddr::new(0, 0), MsgFlags::empty()).map_err(status)?;
        loop {
            if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err(ReadStatus::Unavailable);
            }
            match recvfrom::<NetlinkAddr>(fd, &mut buffer) {
                Ok((len, Some(sender))) if sender.pid() == 0 && sender.groups() == 0 => {
                    budget.bytes += len;
                    // recvfrom cannot distinguish an exactly full buffer from truncation.
                    if len == 0 || len >= buffer.len() || budget.bytes > MAX_BYTES {
                        return Err(ReadStatus::OutOfRange);
                    }
                    if parse(&buffer[..len], seq, family as u8, &mut budget, &mut dist)? {
                        break;
                    }
                }
                Ok(_) => return Err(ReadStatus::Failed),
                Err(Errno::EAGAIN) => thread::sleep(Duration::from_millis(1)),
                Err(Errno::EINTR) => continue,
                Err(error) => return Err(status(error)),
            }
        }
    }
    if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
        return Err(ReadStatus::Unavailable);
    }
    Ok(dist)
}

fn request(seq: u32, family: u8) -> [u8; 72] {
    // nlmsghdr (16 bytes) followed by inet_diag_req_v2 (56 bytes).
    let mut buf = [0; 72];
    buf[..4].copy_from_slice(&72u32.to_ne_bytes());
    buf[4..6].copy_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
    buf[6..8].copy_from_slice(&((libc::NLM_F_REQUEST | libc::NLM_F_DUMP) as u16).to_ne_bytes());
    buf[8..12].copy_from_slice(&seq.to_ne_bytes());
    buf[16] = family;
    buf[17] = libc::IPPROTO_TCP as u8;
    buf[18] = 1 << (INET_DIAG_INFO - 1);
    buf[20..24].copy_from_slice(&(1u32 << 1).to_ne_bytes()); // TCP_ESTABLISHED
    buf[64..72].fill(0xff); // INET_DIAG_NOCOOKIE
    buf
}

struct Budget {
    bytes: usize,
    sockets: usize,
}

fn parse(
    mut buf: &[u8],
    seq: u32,
    family: u8,
    budget: &mut Budget,
    dist: &mut Distribution,
) -> Result<bool, ReadStatus> {
    while !buf.is_empty() {
        if buf.len() < 16 || u32_at(buf, 8) != seq {
            return Err(ReadStatus::Failed);
        }
        let kind = u16_at(buf, 4);
        let flags = u16_at(buf, 6);
        if flags & libc::NLM_F_DUMP_INTR as u16 != 0 {
            return Err(ReadStatus::Unavailable);
        }
        let len = u32_at(buf, 0) as usize;
        let aligned = len.checked_add(3).ok_or(ReadStatus::Failed)? & !3;
        if len < 16 || aligned > buf.len() {
            return Err(ReadStatus::Failed);
        }
        let body = &buf[16..len];
        buf = &buf[aligned..];
        match i32::from(kind) {
            libc::NLMSG_DONE if buf.is_empty() && body.len() == 4 && u32_at(body, 0) == 0 => {
                return Ok(true);
            }
            libc::NLMSG_DONE | libc::NLMSG_ERROR if body.len() >= 4 => {
                let error = i32::from_ne_bytes(body[..4].try_into().unwrap());
                return Err(error
                    .checked_neg()
                    .map_or(ReadStatus::Failed, |e| status(Errno::from_raw(e))));
            }
            kind if kind == i32::from(SOCK_DIAG_BY_FAMILY) => {
                budget.sockets += 1;
                if budget.sockets > MAX_SOCKETS {
                    return Err(ReadStatus::OutOfRange);
                }
                if body.len() < 72 || body[0] != family || body[1] != 1 {
                    return Err(ReadStatus::Failed);
                }
                if let Some(rtt) = rtt(&body[72..])? {
                    dist.observe(f64::from(rtt) / 1_000_000.0);
                }
            }
            _ => return Err(ReadStatus::Failed),
        }
    }
    Ok(false)
}

fn rtt(mut attrs: &[u8]) -> Result<Option<u32>, ReadStatus> {
    let mut sample = None;
    let mut info = false;
    while !attrs.is_empty() {
        if attrs.len() < 4 {
            return Err(ReadStatus::Failed);
        }
        let len = usize::from(u16_at(attrs, 0));
        let aligned = (len + 3) & !3;
        if len < 4 || aligned > attrs.len() {
            return Err(ReadStatus::Failed);
        }
        if u16_at(attrs, 2) == INET_DIAG_INFO {
            if info {
                return Err(ReadStatus::Failed);
            }
            info = true;
            // tcpi_rtt is at byte 68 in Linux's append-only tcp_info.
            if len >= 4 + 72 {
                let rtt = u32_at(attrs, 4 + 68);
                sample = (rtt != 0).then_some(rtt);
            }
        }
        attrs = &attrs[aligned..];
    }
    Ok(sample)
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_ne_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn status(error: Errno) -> ReadStatus {
    match error {
        Errno::EPERM | Errno::EACCES => ReadStatus::PermissionDenied,
        Errno::EAFNOSUPPORT | Errno::EPROTONOSUPPORT | Errno::EOPNOTSUPP => ReadStatus::Unsupported,
        Errno::ENOBUFS | Errno::EINTR | Errno::EAGAIN | Errno::ETIMEDOUT => ReadStatus::Unavailable,
        _ => ReadStatus::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn tcp_info_is_length_checked_and_zero_is_uninitialized() {
        let mut info = [0; 76];
        info[..2].copy_from_slice(&76u16.to_ne_bytes());
        info[2..4].copy_from_slice(&INET_DIAG_INFO.to_ne_bytes());
        assert_eq!(rtt(&info), Ok(None));
        info[72..].copy_from_slice(&250u32.to_ne_bytes());
        assert_eq!(rtt(&info), Ok(Some(250)));
        assert_eq!(rtt(&info[..75]), Err(ReadStatus::Failed));
        info[..2].copy_from_slice(&72u16.to_ne_bytes());
        assert_eq!(rtt(&info[..72]), Ok(None));
    }

    #[test]
    fn interrupted_or_over_budget_dumps_are_rejected() {
        let mut budget = Budget {
            bytes: 0,
            sockets: MAX_SOCKETS,
        };
        let mut dist = Distribution::new(vec![]);
        let mut message = [0; 88];
        message[..4].copy_from_slice(&88u32.to_ne_bytes());
        message[4..6].copy_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
        message[8..12].copy_from_slice(&1u32.to_ne_bytes());
        assert_eq!(
            parse(&message, 1, 2, &mut budget, &mut dist),
            Err(ReadStatus::OutOfRange)
        );
        message[6..8].copy_from_slice(&(libc::NLM_F_DUMP_INTR as u16).to_ne_bytes());
        assert_eq!(
            parse(&message, 1, 2, &mut budget, &mut dist),
            Err(ReadStatus::Unavailable)
        );
        assert!(matches!(
            sweep(&AtomicBool::new(true)),
            Err(ReadStatus::Unavailable)
        ));
    }

    #[test]
    fn kernel_sweep_measures_loopback_sockets_in_this_namespace() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        let result = sweep(&AtomicBool::new(false));
        assert!(result.unwrap().count() > 0);
        drop((client, peer));
    }
}
