use super::signals;
use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl, open};
use nix::sys::{
    signal::{SigSet, SigmaskHow, Signal, pthread_sigmask, raise},
    signalfd::{SfdFlags, SignalFd},
    wait::{Id, WaitPidFlag, WaitStatus, waitid},
};
use nix::{
    sys::stat::Mode,
    unistd::{Pid, close, pipe2},
};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, ExitStatus},
};

pub struct GatedChild {
    child: Child,
    gate: Option<File>,
    signals: SignalFd,
    original_mask: SigSet,
    reaped: bool,
}

fn watched_signals() -> SigSet {
    let mut set = SigSet::all();
    set.remove(Signal::SIGKILL);
    set.remove(Signal::SIGSTOP);
    set
}

impl GatedChild {
    pub fn spawn(command: &[OsString]) -> io::Result<Self> {
        let watched = watched_signals();
        let mut original_mask = SigSet::empty();
        let signals = SignalFd::with_flags(&watched, SfdFlags::SFD_CLOEXEC)?;
        let (read, write) = pipe2(OFlag::O_CLOEXEC)?;
        // spawn waits for exec to complete, so blocking inside pre_exec would
        // deadlock before we obtain the PID and persist its claim. The helper
        // lets spawn return while the workload remains gated. Spawn before
        // blocking so it inherits the original signal mask and standard streams.
        fcntl(&read, FcntlArg::F_SETFD(FdFlag::empty()))?;
        let mut child = Command::new(std::env::current_exe()?)
            .arg("__recount_exec")
            .arg(read.as_raw_fd().to_string())
            .args(command)
            .spawn()?;
        drop(read);
        if let Err(error) = pthread_sigmask(
            SigmaskHow::SIG_BLOCK,
            Some(&watched),
            Some(&mut original_mask),
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
        Ok(Self {
            child,
            gate: Some(File::from(write)),
            signals,
            original_mask,
            reaped: false,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn release(&mut self) -> io::Result<()> {
        self.gate
            .take()
            .ok_or_else(|| io::Error::other("child already released"))?
            .write_all(&[1])
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.child.try_wait()? {
                self.reaped = true;
                return Ok(status);
            }
            let changes = WaitPidFlag::WSTOPPED | WaitPidFlag::WCONTINUED | WaitPidFlag::WNOHANG;
            match waitid(Id::Pid(Pid::from_raw(self.child.id() as i32)), changes) {
                Ok(WaitStatus::Stopped(_, _)) => {
                    raise(Signal::SIGSTOP)?;
                    continue;
                }
                Ok(_) | Err(nix::errno::Errno::EINTR) => {}
                Err(error) => return Err(error.into()),
            }
            let info = match self.signals.read_signal() {
                Ok(Some(info)) => info,
                Ok(None) | Err(nix::errno::Errno::EINTR) => continue,
                Err(error) => return Err(error.into()),
            };
            let number = info.ssi_signo as i32;
            if number == Signal::SIGCHLD as i32 {
                continue;
            }
            // Terminal-generated signals already reach the shared foreground
            // process group. Forward only directed/userspace signals.
            if info.ssi_code != nix::libc::SI_KERNEL {
                let _ = signals::send(Pid::from_raw(self.child.id() as i32), number);
            }
        }
    }
}

impl Drop for GatedChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = pthread_sigmask(SigmaskHow::SIG_SETMASK, Some(&self.original_mask), None);
    }
}

/// Private helper: no workload instruction executes until the durable snapshot
/// is committed and the parent writes the release byte.
pub fn exec_helper() -> ! {
    let result = helper();
    if let Err(error) = result {
        eprintln!("recount: cannot execute command: {error}");
        let code = if error.kind() == io::ErrorKind::NotFound {
            127
        } else {
            126
        };
        std::process::exit(code);
    }
    unreachable!()
}

fn helper() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(2).collect();
    if args.len() < 2 {
        return Err(io::Error::other("invalid exec helper arguments"));
    }
    let fd: i32 = args[0]
        .to_str()
        .and_then(|s| s.parse().ok())
        .filter(|fd| *fd > 2)
        .ok_or_else(|| io::Error::other("invalid gate descriptor"))?;
    let mut gate = File::from(open(
        format!("/proc/self/fd/{fd}").as_str(),
        OFlag::O_RDONLY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )?);
    close(fd)?;
    let mut byte = [0];
    gate.read_exact(&mut byte)?;
    if byte != [1] {
        return Err(io::Error::other("invalid launch gate"));
    }
    drop(gate);
    Err(Command::new(&args[1]).args(&args[2..]).exec())
}

pub fn exit_like(status: ExitStatus) -> ! {
    if let Some(signal) = status.signal() {
        let _ = signals::terminate(signal);
        std::process::exit(128 + signal);
    }
    std::process::exit(status.code().unwrap_or(1));
}
