use prost::Message;
use recount_execution_claims::{
    ExecutionMetadata, ExecutionParameter, Inbox, LocalExecutionClaim, LocalParticipantSubject,
    LocalProcessIncarnation, ProcessExit, process_exit::Outcome, validate,
};
use recount_telemetry_schema::execution::{MAX_CLAIM_BYTES, MAX_SPOOL_CLAIMS_PER_UID};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::Duration,
};
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    _temporary: TempDir,
    root: PathBuf,
    directory: PathBuf,
    uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let uid = nix::unistd::geteuid().as_raw();
        let directory = root.join(uid.to_string());
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            _temporary: temporary,
            root,
            directory,
            uid,
        }
    }

    fn open(&self) -> Inbox {
        Inbox::open(&self.root, self.uid).unwrap()
    }

    fn claim(&self) -> LocalExecutionClaim {
        LocalExecutionClaim {
            claim_id: Uuid::new_v4().to_string(),
            revision: 1,
            execution_key: "slurm:48213".into(),
            boot_id: Uuid::new_v4().to_string(),
            subject: Some(LocalParticipantSubject {
                process: Some(LocalProcessIncarnation {
                    pid: 42,
                    start_time_ticks: 0,
                }),
                dedicated_cgroup: false,
            }),
            owner_uid: self.uid,
            first_seen_unix_nano: 100,
            last_seen_unix_nano: 100,
            ..Default::default()
        }
    }
}

#[test]
fn collector_enumerates_provisioned_uids_without_a_configured_list() {
    let fixture = Fixture::new();
    assert_eq!(Inbox::enumerate_uids(&fixture.root).unwrap(), [fixture.uid]);
    let alias = fixture.root.join(format!("0{}", fixture.uid));
    symlink(&fixture.directory, &alias).unwrap();
    assert!(Inbox::enumerate_uids(&fixture.root).is_err());
    fs::remove_file(alias).unwrap();
    fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(Inbox::enumerate_uids(&fixture.root).unwrap(), [fixture.uid]);
    assert!(Inbox::open(&fixture.root, fixture.uid).is_err());
    fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o700)).unwrap();
    let other_uid = fixture.uid.wrapping_add(1);
    let linked = fixture.root.join(other_uid.to_string());
    symlink(&fixture.directory, linked).unwrap();
    let mut expected = vec![fixture.uid, other_uid];
    expected.sort_unstable();
    assert_eq!(Inbox::enumerate_uids(&fixture.root).unwrap(), expected);
    assert!(Inbox::open(&fixture.root, other_uid).is_err());
    assert!(fixture.open().try_lock().is_ok());
}

#[test]
fn durable_snapshots_survive_reopen_and_terminal_removal_checks_revision() {
    let fixture = Fixture::new();
    let mut claim = fixture.claim();
    {
        let mut inbox = fixture.open();
        inbox.lock().unwrap().write(&claim).unwrap();
    }
    let file = fixture.directory.join(format!("{}.pb", claim.claim_id));
    assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
    assert_eq!(fs::metadata(&file).unwrap().uid(), fixture.uid);
    let mut inbox = fixture.open();
    let mut locked = inbox.lock().unwrap();
    assert_eq!(locked.enumerate().unwrap(), [claim.claim_id.clone()]);
    assert_eq!(locked.read(&claim.claim_id).unwrap(), claim);
    assert!(locked.remove_terminal(&claim).is_err());
    assert!(locked.write(&claim).is_err());
    let initial = claim.clone();
    claim.revision = 2;
    claim.ended_unix_nano = Some(200);
    claim.exit = Some(ProcessExit {
        time_unix_nano: 200,
        outcome: Some(Outcome::Code(0)),
    });
    locked.write(&claim).unwrap();
    assert!(locked.remove_terminal(&initial).is_err());
    assert_eq!(locked.read(&claim.claim_id).unwrap(), claim);
    claim.revision = 3;
    assert!(locked.write(&claim).is_err());
    claim.revision = 2;
    locked.remove_terminal(&claim).unwrap();
    assert!(locked.enumerate().unwrap().is_empty());
}

#[test]
fn directory_lock_serializes_independent_handles() {
    let fixture = Fixture::new();
    let mut first = fixture.open();
    let mut second = fixture.open();
    let guard = first.lock().unwrap();
    let (send, receive) = mpsc::channel();
    let worker = thread::spawn(move || {
        let _guard = second.lock().unwrap();
        send.send(()).unwrap();
    });
    assert!(receive.recv_timeout(Duration::from_millis(50)).is_err());
    drop(guard);
    receive.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap();
}

#[test]
fn collector_lock_reports_busy_without_waiting() {
    let fixture = Fixture::new();
    let mut first = fixture.open();
    let mut second = fixture.open();
    let guard = first.lock().unwrap();
    let (send, receive) = mpsc::channel();
    let worker = thread::spawn(move || {
        let kind = second.try_lock().err().map(|error| error.kind());
        send.send(kind).unwrap();
        second
    });
    let busy = receive.recv_timeout(Duration::from_secs(5));
    drop(guard);
    let mut second = worker.join().unwrap();
    assert_eq!(busy.unwrap(), Some(std::io::ErrorKind::WouldBlock));
    assert!(second.try_lock().is_ok());
}

#[test]
fn replaced_lock_and_symlinked_directory_are_rejected() {
    let fixture = Fixture::new();
    let mut inbox = fixture.open();
    fs::rename(
        fixture.directory.join(".lock"),
        fixture.root.join("old-lock"),
    )
    .unwrap();
    let mut replacement = fixture.open();
    assert!(inbox.lock().is_err());
    assert!(replacement.lock().is_ok());
    let alias = fixture.root.join("alias");
    symlink(&fixture.root, &alias).unwrap();
    assert!(Inbox::open(alias, fixture.uid).is_err());
}

#[test]
fn revisions_preserve_start_identity_and_metadata() {
    let fixture = Fixture::new();
    let claim = fixture.claim();
    let mut inbox = fixture.open();
    let mut locked = inbox.lock().unwrap();
    locked.write(&claim).unwrap();
    let mut changed = claim.clone();
    changed.revision = 2;
    changed.execution_key = "other:key".into();
    assert!(locked.write(&changed).is_err());
    changed = claim.clone();
    changed.revision = 2;
    changed.first_seen_unix_nano -= 1;
    assert!(locked.write(&changed).is_err());
    changed = claim.clone();
    changed.revision = 2;
    changed.metadata = Some(ExecutionMetadata {
        name: Some("changed".into()),
        ..Default::default()
    });
    assert!(locked.write(&changed).is_err());
    changed = claim.clone();
    changed.revision = 2;
    changed.subject.as_mut().unwrap().dedicated_cgroup = true;
    assert!(locked.write(&changed).is_err());
    changed = claim.clone();
    changed.revision = 3;
    assert!(locked.write(&changed).is_err());
    assert_eq!(locked.read(&claim.claim_id).unwrap(), claim);
}

#[test]
fn unsafe_directories_locks_and_files_are_rejected_without_following_links() {
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Inbox::open(&fixture.root, fixture.uid).is_err());
    fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o700)).unwrap();
    let outside = fixture.root.join("outside");
    fs::write(&outside, b"untouched").unwrap();
    symlink(&outside, fixture.directory.join(".lock")).unwrap();
    assert!(Inbox::open(&fixture.root, fixture.uid).is_err());
    fs::remove_file(fixture.directory.join(".lock")).unwrap();
    let mut inbox = fixture.open();
    let locked = inbox.lock().unwrap();
    let claim = fixture.claim();
    let path = fixture.directory.join(format!("{}.pb", claim.claim_id));
    symlink(&outside, &path).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    assert!(locked.enumerate().is_err());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    assert!(locked.enumerate().is_err());
    fs::remove_dir(&path).unwrap();
    fs::write(&path, claim.encode_to_vec()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&path, fixture.root.join("hardlink")).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"untouched");
}

#[test]
fn capacity_never_evicts_and_replacements_reserve_temporary_bytes() {
    let fixture = Fixture::new();
    let claim = fixture.claim();
    let mut inbox = fixture.open();
    let mut locked = inbox.lock().unwrap();
    locked.write(&claim).unwrap();
    // Sparse files exercise the exact 64 MiB accounting without writing 64 MiB.
    for _ in 1..MAX_SPOOL_CLAIMS_PER_UID {
        let path = fixture.directory.join(format!("{}.pb", Uuid::new_v4()));
        let file = fs::File::create(&path).unwrap();
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        file.set_len(MAX_CLAIM_BYTES as u64).unwrap();
    }
    assert!(locked.write(&fixture.claim()).is_err());
    let mut terminal = claim.clone();
    terminal.revision = 2;
    terminal.ended_unix_nano = Some(200);
    terminal.exit = Some(ProcessExit {
        time_unix_nano: 200,
        outcome: Some(Outcome::Code(0)),
    });
    // There is space for this small replacement at the claim-count limit.
    locked.write(&terminal).unwrap();
    assert_eq!(locked.enumerate().unwrap().len(), MAX_SPOOL_CLAIMS_PER_UID);
    assert_eq!(locked.read(&terminal.claim_id).unwrap(), terminal);
    let temporary = fixture.directory.join(format!(".tmp-{}", Uuid::new_v4()));
    let file = fs::File::create(temporary).unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    file.set_len(MAX_CLAIM_BYTES as u64).unwrap();
    let mut next = fixture.claim();
    // New claims and replacements both account for retained temporary space.
    assert!(locked.write(&next).is_err());
    next.claim_id = claim.claim_id;
    next.revision = 3;
    assert!(locked.write(&next).is_err());
}

#[test]
fn byte_capacity_reserves_the_whole_atomic_replacement_not_just_growth() {
    let fixture = Fixture::new();
    let mut claim = fixture.claim();
    claim.metadata = Some(ExecutionMetadata {
        parameters: (0..32)
            .map(|i| ExecutionParameter {
                key: format!("p{i:02}"),
                value: "x".repeat(1024),
            })
            .collect(),
        ..Default::default()
    });
    let mut inbox = fixture.open();
    let mut locked = inbox.lock().unwrap();
    locked.write(&claim).unwrap();
    for _ in 1..MAX_SPOOL_CLAIMS_PER_UID {
        let file =
            fs::File::create(fixture.directory.join(format!("{}.pb", Uuid::new_v4()))).unwrap();
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .unwrap();
        file.set_len(MAX_CLAIM_BYTES as u64).unwrap();
    }
    let initial = claim.clone();
    claim.revision = 2;
    claim.ended_unix_nano = Some(200);
    claim.exit = Some(ProcessExit {
        time_unix_nano: 200,
        outcome: Some(Outcome::Code(0)),
    });
    assert!(locked.write(&claim).is_err());
    assert_eq!(locked.read(&claim.claim_id).unwrap(), initial);
    assert!(!fixture.directory.read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tmp-")
    }));
}

#[cfg(target_os = "linux")]
#[test]
fn collector_creates_uid_owned_lock_and_rejects_foreign_file_owners() {
    if nix::unistd::geteuid().as_raw() != 0 {
        return;
    }
    let fixture = Fixture::new();
    let other_uid = 62096;
    let directory = fixture.root.join(other_uid.to_string());
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    nix::unistd::chown(
        &directory,
        Some(nix::unistd::Uid::from_raw(other_uid)),
        None,
    )
    .unwrap();
    let mut other = Inbox::open(&fixture.root, other_uid).unwrap();
    assert_eq!(
        fs::metadata(directory.join(".lock")).unwrap().uid(),
        other_uid
    );
    assert!(other.lock().is_ok());
    let mut inbox = fixture.open();
    let mut locked = inbox.lock().unwrap();
    let claim = fixture.claim();
    locked.write(&claim).unwrap();
    let path = fixture.directory.join(format!("{}.pb", claim.claim_id));
    nix::unistd::chown(&path, Some(nix::unistd::Uid::from_raw(other_uid)), None).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    assert!(locked.enumerate().is_err());
}

#[test]
fn malformed_oversized_and_mismatched_snapshots_fail_closed() {
    let fixture = Fixture::new();
    let mut inbox = fixture.open();
    let locked = inbox.lock().unwrap();
    let mut claim = fixture.claim();
    let path = fixture.directory.join(format!("{}.pb", claim.claim_id));
    fs::write(&path, b"not protobuf").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_CLAIM_BYTES as u64 + 1)
        .unwrap();
    assert!(locked.read(&claim.claim_id).is_err());
    let filename = claim.claim_id.clone();
    claim.claim_id = Uuid::new_v4().to_string();
    fs::write(&path, claim.encode_to_vec()).unwrap();
    assert!(locked.read(&filename).is_err());
    claim.claim_id = filename.clone();
    claim.owner_uid = fixture.uid.wrapping_add(1);
    fs::write(&path, claim.encode_to_vec()).unwrap();
    assert!(locked.read(&filename).is_err());
}

#[test]
fn local_validation_enforces_keys_metadata_identities_and_outcomes() {
    let fixture = Fixture::new();
    let claim = fixture.claim();
    validate(&claim).unwrap();
    for key in ["", " slurm:1", "é", "-run", "run\n", &"a".repeat(129)] {
        let mut invalid = claim.clone();
        invalid.execution_key = key.into();
        assert!(validate(&invalid).is_err(), "{key:?}");
    }
    let mut invalid = claim.clone();
    invalid.metadata = Some(ExecutionMetadata {
        name: Some(" valid".into()),
        ..Default::default()
    });
    assert!(validate(&invalid).is_err());
    invalid.metadata = Some(ExecutionMetadata {
        parameters: vec![
            ExecutionParameter {
                key: "x".into(),
                value: "".into(),
            },
            ExecutionParameter {
                key: "x".into(),
                value: "duplicate".into(),
            },
        ],
        ..Default::default()
    });
    assert!(validate(&invalid).is_err());
    invalid = claim.clone();
    invalid.exit = Some(ProcessExit {
        time_unix_nano: 100,
        outcome: Some(Outcome::Signal(0)),
    });
    assert!(validate(&invalid).is_err());
    invalid.ended_unix_nano = Some(200);
    assert!(validate(&invalid).is_err());
    invalid.exit.as_mut().unwrap().outcome = Some(Outcome::Code(0));
    validate(&invalid).unwrap();
    invalid.ended_unix_nano = None;
    assert!(validate(&invalid).is_err());
    invalid = claim;
    invalid
        .subject
        .as_mut()
        .unwrap()
        .process
        .as_mut()
        .unwrap()
        .pid = 0;
    assert!(validate(&invalid).is_err());
}
