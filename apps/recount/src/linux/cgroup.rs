use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::{Mode, fstat, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use recount_telemetry_schema::execution::MAX_CGROUP_PATH_BYTES;
use std::{
    fs::File,
    io::{self, Write},
    os::fd::OwnedFd,
};

const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);

pub struct DelegatedCgroup {
    parent: OwnedFd,
    directory: OwnedFd,
    name: String,
    path: String,
    retained: bool,
}

impl DelegatedCgroup {
    pub fn create(id: &str, uid: u32) -> io::Result<Self> {
        let subtree = match std::env::var("RECOUNT_CGROUP_SUBTREE") {
            Ok(hint) => hint,
            Err(std::env::VarError::NotPresent) => {
                current_v2_path(&std::fs::read_to_string("/proc/self/cgroup")?)?
            }
            Err(_) => return Err(io::Error::other("invalid cgroup creation hint")),
        };
        let name = format!("recount-{id}");
        let path = format!("{}/{name}", subtree.trim_end_matches('/'));
        if !subtree.starts_with('/')
            || path.len() > MAX_CGROUP_PATH_BYTES
            || subtree.chars().any(char::is_control)
            || (subtree != "/"
                && subtree[1..]
                    .split('/')
                    .any(|part| matches!(part, "" | "." | "..")))
        {
            return Err(io::Error::other("invalid delegated cgroup v2 path"));
        }
        let mut parent = open("/sys/fs/cgroup", DIRECTORY, Mode::empty())?;
        // A v2 mount exposes cgroup.controllers at its root.
        openat(
            &parent,
            "cgroup.controllers",
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?;
        for part in subtree[1..].split('/').filter(|part| !part.is_empty()) {
            parent = openat(&parent, part, DIRECTORY, Mode::empty())?;
        }
        mkdirat(
            &parent,
            name.as_str(),
            Mode::S_IRUSR | Mode::S_IWUSR | Mode::S_IXUSR,
        )?;
        let directory = match openat(&parent, name.as_str(), DIRECTORY, Mode::empty()) {
            Ok(directory) => directory,
            Err(error) => {
                let _ = unlinkat(&parent, name.as_str(), UnlinkatFlags::RemoveDir);
                return Err(error.into());
            }
        };
        let stat = fstat(&directory)?;
        if stat.st_uid != uid {
            let _ = unlinkat(&parent, name.as_str(), UnlinkatFlags::RemoveDir);
            return Err(io::Error::other("new cgroup is not owned by launcher UID"));
        }
        if let Err(error) = openat(
            &directory,
            "cgroup.procs",
            OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            let _ = unlinkat(&parent, name.as_str(), UnlinkatFlags::RemoveDir);
            return Err(error.into());
        }
        Ok(Self {
            parent,
            directory,
            name,
            path,
            retained: false,
        })
    }

    pub fn attach(&mut self, pid: u32) -> io::Result<()> {
        let mut procs = File::from(openat(
            &self.directory,
            "cgroup.procs",
            OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?);
        write!(procs, "{pid}")?;
        let placement = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))?;
        if !placement
            .lines()
            .any(|line| line.strip_prefix("0::") == Some(self.path.as_str()))
        {
            return Err(io::Error::other(
                "cannot verify launched root cgroup placement",
            ));
        }
        Ok(())
    }

    pub fn retain_for_collector(&mut self) {
        self.retained = true;
    }
}

fn current_v2_path(contents: &str) -> io::Result<String> {
    contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("process has no unified cgroup v2 placement"))
}

impl Drop for DelegatedCgroup {
    fn drop(&mut self) {
        if !self.retained {
            let _ = unlinkat(&self.parent, self.name.as_str(), UnlinkatFlags::RemoveDir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::current_v2_path;

    #[test]
    fn current_location_uses_only_the_unified_hierarchy() {
        assert_eq!(
            current_v2_path("7:cpu:/legacy\n0::/jobs/current\n").unwrap(),
            "/jobs/current"
        );
        assert_eq!(current_v2_path("0::/\n").unwrap(), "/");
        assert!(current_v2_path("7:cpu:/legacy\n").is_err());
    }
}
