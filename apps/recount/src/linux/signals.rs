#![allow(unsafe_code)]

use nix::{
    errno::Errno,
    libc,
    sys::signal::{SaFlags, SigAction, SigHandler, SigSet, SigmaskHow, pthread_sigmask},
    unistd::{Pid, getpid},
};
use std::{io, ptr};

/// Nix's Signal enum excludes realtime signals. Keep raw signal operations
/// here so forwarding and final wait status preserve those signals too.
pub fn send(pid: Pid, signal: i32) -> io::Result<()> {
    if pid.as_raw() <= 0 || !(1..=libc::SIGRTMAX()).contains(&signal) {
        return Err(Errno::EINVAL.into());
    }
    // SAFETY: kill has no pointer arguments; a strictly positive PID addresses
    // only the requested process, never a process group or all permitted PIDs.
    Errno::result(unsafe { libc::kill(pid.as_raw(), signal) })?;
    Ok(())
}

pub fn terminate(signal: i32) -> io::Result<()> {
    if !(1..=libc::SIGRTMAX()).contains(&signal) {
        return Err(Errno::EINVAL.into());
    }
    if signal != libc::SIGKILL {
        let action: libc::sigaction =
            SigAction::new(SigHandler::SigDfl, SaFlags::empty(), SigSet::empty()).into();
        // SAFETY: this single-threaded launcher is about to terminate. Install
        // only SIG_DFL, with no callback or borrowed handler state. action is a
        // valid libc sigaction built by nix and lives through the call.
        Errno::result(unsafe { libc::sigaction(signal, &action, ptr::null_mut()) })?;
    }
    pthread_sigmask(SigmaskHow::SIG_SETMASK, Some(&SigSet::empty()), None)?;
    send(getpid(), signal)
}

#[cfg(test)]
mod tests {
    use super::send;
    use nix::{libc, unistd::Pid};

    #[test]
    fn forwarding_rejects_process_groups_and_invalid_signals() {
        for pid in [0, -1, -42] {
            assert!(send(Pid::from_raw(pid), libc::SIGTERM).is_err());
        }
        for signal in [0, -1, libc::SIGRTMAX() + 1] {
            assert!(send(Pid::this(), signal).is_err());
        }
    }
}
