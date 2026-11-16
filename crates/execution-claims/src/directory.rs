use crate::{LocalExecutionClaim, validate, validation};
use nix::{
    dir::Dir,
    fcntl::{AtFlags, Flock, FlockArg, OFlag, open, openat, renameat},
    sys::stat::{FileStat, Mode, SFlag, fchmod, fstat, fstatat},
    unistd::{Uid, UnlinkatFlags, fchown, fsync, geteuid, unlinkat},
};
use prost::Message;
use recount_telemetry_schema::execution::{
    MAX_CLAIM_BYTES, MAX_SPOOL_BYTES_PER_UID, MAX_SPOOL_CLAIMS_PER_UID,
};
use std::{
    fs::File,
    io::{self, Read, Write},
    os::fd::OwnedFd,
    path::{Component, Path},
};
use uuid::Uuid;

const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);
const REGULAR: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC)
    .union(OFlag::O_NONBLOCK);

/// A provisioned UID inbox held open without following path symlinks.
pub struct Inbox {
    directory: OwnedFd,
    lock: File,
    uid: u32,
}

/// Exclusive advisory lock shared by launcher writes and collector cleanup.
/// Dropping the guard releases the lock. Do not recursively lock an inbox.
pub struct LockedInbox<'a> {
    inbox: &'a mut Inbox,
    _lock: Flock<File>,
}

fn check_regular(stat: &FileStat, uid: u32, max: u64) -> io::Result<()> {
    if SFlag::from_bits_truncate(stat.st_mode) != SFlag::S_IFREG
        || stat.st_uid != uid
        || stat.st_mode & 0o7777 != 0o600
        || stat.st_nlink != 1
        || stat.st_size < 0
        || stat.st_size as u64 > max
    {
        return Err(validation::invalid("unsafe or oversized inbox file"));
    }
    Ok(())
}

fn check_uid_directory(stat: &FileStat, uid: u32) -> io::Result<()> {
    if SFlag::from_bits_truncate(stat.st_mode) != SFlag::S_IFDIR
        || stat.st_uid != uid
        || stat.st_mode & 0o7777 != 0o700
    {
        return Err(validation::invalid(
            "UID directory must be owned by UID with mode 0700",
        ));
    }
    Ok(())
}

fn trusted_root(path: &Path) -> io::Result<OwnedFd> {
    if !path.is_absolute() {
        return Err(validation::invalid("claim directory must be absolute"));
    }
    let mut directory = open("/", DIRECTORY, Mode::empty())?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = openat(&directory, Path::new(name), DIRECTORY, Mode::empty())?;
            }
            _ => return Err(validation::invalid("invalid claim directory path")),
        }
    }
    let stat = fstat(&directory)?;
    let uid = geteuid().as_raw();
    if ![0, uid].contains(&stat.st_uid) || stat.st_mode & 0o022 != 0 {
        return Err(validation::invalid(
            "untrusted claim directory owner or mode",
        ));
    }
    Ok(directory)
}

impl Inbox {
    /// Enumerate provisioned decimal UID directories without a configured UID
    /// list. Reject unexpected names. Directory metadata is checked by
    /// [`Self::open`] so one unsafe UID directory cannot abort the whole scan.
    pub fn enumerate_uids(root: impl AsRef<Path>) -> io::Result<Vec<u32>> {
        let root = trusted_root(root.as_ref())?;
        let mut directory = Dir::openat(&root, ".", DIRECTORY, Mode::empty())?;
        let mut uids = Vec::new();
        for entry in directory.iter() {
            let entry = entry?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| validation::invalid("invalid UID directory name"))?;
            if matches!(name, "." | "..") {
                continue;
            }
            let uid = name
                .parse::<u32>()
                .ok()
                .filter(|uid| uid.to_string() == name)
                .ok_or_else(|| validation::invalid("invalid UID directory name"))?;
            uids.push(uid);
        }
        uids.sort_unstable();
        Ok(uids)
    }

    /// Open an existing root and its decimal UID child. The root must be owned
    /// by root or the caller and not group/world writable; the child must be
    /// owned by `uid` with mode 0700. Collector callers normally run as root.
    pub fn open(root: impl AsRef<Path>, uid: u32) -> io::Result<Self> {
        let root = trusted_root(root.as_ref())?;
        let directory = openat(&root, uid.to_string().as_str(), DIRECTORY, Mode::empty())?;
        check_uid_directory(&fstat(&directory)?, uid)?;
        let lock = match openat(
            &directory,
            ".lock",
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        ) {
            Ok(lock) => {
                fchmod(&lock, Mode::S_IRUSR | Mode::S_IWUSR)?;
                if geteuid().as_raw() != uid {
                    fchown(&lock, Some(Uid::from_raw(uid)), None)?;
                }
                fsync(&lock)?;
                fsync(&directory)?;
                lock
            }
            Err(nix::errno::Errno::EEXIST) => openat(
                &directory,
                ".lock",
                OFlag::O_RDWR | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )?,
            Err(error) => return Err(error.into()),
        };
        check_regular(&fstat(&lock)?, uid, 0)?;
        Ok(Self {
            directory,
            lock: File::from(lock),
            uid,
        })
    }

    /// Block until the UID's exclusive lock is acquired. For launcher writes;
    /// collectors must use [`Self::try_lock`] to avoid blocking other UIDs.
    pub fn lock(&mut self) -> io::Result<LockedInbox<'_>> {
        self.acquire(FlockArg::LockExclusive)
    }

    /// Acquire the UID lock without waiting. A held lock returns
    /// [`io::ErrorKind::WouldBlock`]; collectors must skip this UID and retry.
    pub fn try_lock(&mut self) -> io::Result<LockedInbox<'_>> {
        self.acquire(FlockArg::LockExclusiveNonblock)
    }

    fn acquire(&mut self, operation: FlockArg) -> io::Result<LockedInbox<'_>> {
        let lock = Flock::lock(self.lock.try_clone()?, operation)
            .map_err(|(_, error)| io::Error::from(error))?;
        self.check_lock()?;
        Ok(LockedInbox {
            inbox: self,
            _lock: lock,
        })
    }

    fn check_lock(&self) -> io::Result<()> {
        let held = fstat(&self.lock)?;
        let current = fstatat(&self.directory, ".lock", AtFlags::AT_SYMLINK_NOFOLLOW)?;
        check_regular(&current, self.uid, 0)?;
        if held.st_dev != current.st_dev || held.st_ino != current.st_ino {
            return Err(validation::invalid("inbox lock was replaced"));
        }
        Ok(())
    }
}

impl LockedInbox<'_> {
    fn file(&self, name: &str) -> io::Result<File> {
        let fd = openat(&self.inbox.directory, name, REGULAR, Mode::empty())?;
        check_regular(&fstat(&fd)?, self.inbox.uid, MAX_CLAIM_BYTES as u64)?;
        Ok(File::from(fd))
    }

    fn entries(&self) -> io::Result<Vec<(String, u64)>> {
        let mut entries = Vec::new();
        let mut directory = Dir::openat(&self.inbox.directory, ".", DIRECTORY, Mode::empty())?;
        for entry in directory.iter() {
            let entry = entry?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| validation::invalid("invalid filename"))?;
            if matches!(name, "." | ".." | ".lock") {
                continue;
            }
            let id = name
                .strip_suffix(".pb")
                .or_else(|| name.strip_prefix(".tmp-"));
            if !id.is_some_and(validation::uuid) {
                return Err(validation::invalid("unexpected inbox entry"));
            }
            let stat = fstatat(&self.inbox.directory, name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
            check_regular(&stat, self.inbox.uid, MAX_CLAIM_BYTES as u64)?;
            entries.push((name.to_owned(), stat.st_size as u64));
        }
        Ok(entries)
    }

    /// Enumerate snapshot UUIDs, validating entry type, owner, mode and size.
    /// Temporary files are capacity-accounted but are not snapshots.
    pub fn enumerate(&self) -> io::Result<Vec<String>> {
        let mut ids: Vec<_> = self
            .entries()?
            .into_iter()
            .filter_map(|(name, _)| name.strip_suffix(".pb").map(str::to_owned))
            .collect();
        ids.sort_unstable();
        Ok(ids)
    }

    /// Read and validate one complete snapshot, including its filename/owner.
    pub fn read(&self, claim_id: &str) -> io::Result<LocalExecutionClaim> {
        if !validation::uuid(claim_id) {
            return Err(validation::invalid("invalid claim filename"));
        }
        let file = self.file(&format!("{claim_id}.pb"))?;
        let mut bytes = Vec::new();
        file.take(MAX_CLAIM_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_CLAIM_BYTES {
            return Err(validation::invalid("oversized claim"));
        }
        let snapshot = LocalExecutionClaim::decode(bytes.as_slice())
            .map_err(|_| validation::invalid("invalid claim protobuf"))?;
        validate(&snapshot)?;
        if snapshot.claim_id != claim_id || snapshot.owner_uid != self.inbox.uid {
            return Err(validation::invalid("claim filename or owner mismatch"));
        }
        Ok(snapshot)
    }

    /// Persist revision 1, or the next revision of a nonterminal snapshot.
    /// Syncs a 0600 temporary file, renames it and syncs the directory. Capacity
    /// includes existing temporary files and the complete replacement bytes.
    /// Only the owning UID may write. A terminal snapshot is immutable.
    pub fn write(&mut self, snapshot: &LocalExecutionClaim) -> io::Result<()> {
        validate(snapshot)?;
        if snapshot.owner_uid != self.inbox.uid || geteuid().as_raw() != self.inbox.uid {
            return Err(validation::invalid("only the owning UID may write a claim"));
        }
        let bytes = snapshot.encode_to_vec();
        if bytes.len() > MAX_CLAIM_BYTES {
            return Err(validation::invalid("oversized claim"));
        }
        let entries = self.entries()?;
        let name = format!("{}.pb", snapshot.claim_id);
        let replacement = entries.iter().any(|(entry, _)| entry == &name);
        if replacement {
            let previous = self.read(&snapshot.claim_id)?;
            let mut expected = previous.clone();
            expected.revision = snapshot.revision;
            expected.last_seen_unix_nano = snapshot.last_seen_unix_nano;
            expected.ended_unix_nano = snapshot.ended_unix_nano;
            expected.exit = snapshot.exit;
            if previous.exit.is_some()
                || previous.revision.checked_add(1) != Some(snapshot.revision)
                || snapshot.last_seen_unix_nano < previous.last_seen_unix_nano
                || expected != *snapshot
            {
                return Err(validation::invalid(
                    "invalid snapshot revision or changed identity",
                ));
            }
        } else if snapshot.revision != 1 {
            return Err(validation::invalid("initial snapshot revision must be 1"));
        }
        let size: u64 = entries.iter().map(|(_, size)| size).sum();
        if (!replacement && entries.len() >= MAX_SPOOL_CLAIMS_PER_UID)
            || size + bytes.len() as u64 > MAX_SPOOL_BYTES_PER_UID as u64
        {
            return Err(io::Error::other("claim inbox capacity exceeded"));
        }
        let temporary = format!(".tmp-{}", Uuid::new_v4());
        self.replace(&temporary, &name, &bytes)
    }

    fn replace(&self, temporary: &str, name: &str, bytes: &[u8]) -> io::Result<()> {
        let mut file = File::from(openat(
            &self.inbox.directory,
            temporary,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )?);
        let result = (|| {
            fchmod(&file, Mode::S_IRUSR | Mode::S_IWUSR)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            renameat(
                &self.inbox.directory,
                temporary,
                &self.inbox.directory,
                name,
            )?;
            fsync(&self.inbox.directory)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = unlinkat(&self.inbox.directory, temporary, UnlinkatFlags::NoRemoveDir);
            let _ = fsync(&self.inbox.directory);
        }
        result
    }

    /// Remove exactly this terminal revision after the caller has committed
    /// durable collector ownership, including still-live cgroup tracking.
    /// A changed/nonterminal snapshot is never removed. Syncs the directory.
    pub fn remove_terminal(&mut self, owned: &LocalExecutionClaim) -> io::Result<()> {
        if owned.exit.is_none() || self.read(&owned.claim_id)? != *owned {
            return Err(validation::invalid(
                "terminal snapshot changed or is not owned",
            ));
        }
        unlinkat(
            &self.inbox.directory,
            format!("{}.pb", owned.claim_id).as_str(),
            UnlinkatFlags::NoRemoveDir,
        )?;
        fsync(&self.inbox.directory)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Inbox;
    use std::{fs, os::unix::fs::PermissionsExt};
    use uuid::Uuid;

    #[test]
    fn failed_exclusive_create_never_removes_an_existing_temporary_file() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = nix::unistd::geteuid().as_raw();
        let directory = root.join(uid.to_string());
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let mut inbox = Inbox::open(root, uid).unwrap();
        let locked = inbox.lock().unwrap();
        let name = format!(".tmp-{}", Uuid::new_v4());
        fs::write(directory.join(&name), b"retained replacement").unwrap();
        assert!(locked.replace(&name, "unused.pb", b"new content").is_err());
        assert_eq!(
            fs::read(directory.join(name)).unwrap(),
            b"retained replacement"
        );
    }
}
