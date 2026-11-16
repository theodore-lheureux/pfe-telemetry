# Local execution claims

`recount-execution-claims` provides the launcher writer and collector reader for bare Protobuf `LocalExecutionClaim` snapshots. It has no network or database dependency and does not authorize cgroups or attest kernel identity.

## Reader and writer API

- `Inbox::enumerate_uids(root)` discovers decimal UID names without a configured UID list. Directory metadata is checked separately when opening each inbox.
- `Inbox::open(root, uid)` opens the provisioned decimal UID directory, rejecting symlinks and unsafe ownership or permissions.
- `Inbox::lock()` waits for the exclusive advisory `.lock` and returns a `LockedInbox`. The launcher uses this blocking operation.
- `Inbox::try_lock()` acquires the same lock without waiting and returns `WouldBlock` when busy. Collectors must use this operation. Dropping either guard releases the lock.
- `LockedInbox::enumerate()` returns sorted snapshot UUIDs after checking entry ownership, permissions, type and size. Temporary files count toward capacity but are not returned as snapshots.
- `LockedInbox::read(id)` reads and validates one complete snapshot, including the file UID and claim UUID.
- `LockedInbox::write(snapshot)` persists revision 1 or the next revision of a nonterminal claim. Identity, metadata and start remain unchanged. It syncs a `0600` temporary file, atomically renames it, then syncs the directory.
- `LockedInbox::remove_terminal(snapshot)` removes exactly the supplied terminal revision and syncs the directory. A stale revision or nonterminal snapshot fails.
- `validate(snapshot)` and `validate_metadata(metadata)` apply the local contract's structural and byte limits.

Provision the root and UID directory before opening an inbox. Neither writer nor reader creates UID directories. The root must be owned by root or the caller and not group/world writable; each UID child must have mode `0700` and be owned by that UID. Snapshot and lock files must be single-link regular files owned by that UID with mode `0600`. Open operations are relative to directory handles and do not follow symlinks.

## Collector handoff

Collectors must use `try_lock()`, skip a busy UID inbox and retry it on a later scan. A local user can hold its lock indefinitely; waiting on it must not stall intake for other UIDs. Isolate every per-UID error, including unsafe directory metadata, a bad lock or a malformed claim entry: report it for that UID, retain its files and continue scanning the other UIDs rather than failing the whole scan.

Hold the UID lock while enumerating, reading, durably copying a snapshot and deciding whether to remove it. Commit the snapshot and processing cursor to collector state before removal. For a terminal claim with a live cgroup, durable ownership must include continued cgroup tracking. Retain the file if copying fails. The API checks terminal content and revision; the caller supplies the durable-ownership guarantee.

The collector verifies the live root's UID and identity in its own view. A dedicated-cgroup boolean selects observed cgroup membership instead of ancestry; each candidate cgroup member must have the claim's UID. There is no UID/subtree allowlist and no launcher-supplied cgroup identity or namespace ID. A root already exited at first discovery supplies lifecycle timing/exit only, without retrospective membership.

Local revisions are independent of exported fact revisions. After durable collector state loss, allocate fresh participant and fact IDs while retaining the launcher claim UUID as provenance.

Temporary files left by an interrupted writer are retained and count toward capacity. There is no automatic age eviction or cleanup of another claim. Invalid entries fail closed; operators must investigate them rather than treating them as delivered snapshots.

The [execution participant contract](../../docs/execution-participants.md) defines limits, authorization and lifecycle semantics.
