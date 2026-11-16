use recount_execution_claims::LocalProcessIncarnation;
use std::{fs, io};

/// Verify the helper in the same procfs PID view before releasing it to exec.
pub fn verify(pid: u32, uid: u32) -> io::Result<LocalProcessIncarnation> {
    let own = fs::read_to_string("/proc/self/stat")?;
    if !own.starts_with(&format!("{} ", std::process::id())) {
        return Err(io::Error::other("procfs PID view differs from launcher"));
    }
    let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
    let owners = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .ok_or_else(|| io::Error::other("missing process UID"))?;
    if !owners
        .split_whitespace()
        .all(|value| value.parse::<u32>() == Ok(uid))
    {
        return Err(io::Error::other("root process UID differs from launcher"));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::other("invalid process stat"))?
        .1;
    let ticks = fields
        .split_whitespace()
        .nth(19)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("missing process start ticks"))?;
    Ok(LocalProcessIncarnation {
        pid,
        start_time_ticks: ticks,
    })
}
