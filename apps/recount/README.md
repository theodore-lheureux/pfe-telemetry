# Recount launcher

`recount run` starts a Linux command as an execution participant without contacting the collector or backend.

```sh
cargo build --locked -p recount
RECOUNT_CLAIM_DIRECTORY=/var/lib/recount/claims \
RECOUNT_CGROUP_SUBTREE=/user.slice/recount-jobs \
recount run --execution "slurm:$SLURM_JOB_ID" \
  --name "Simulation" --version "2026.11" --param mesh=large -- ./simulation
```

Install the built `recount` binary on `PATH` before using this example. Cargo reports the artifact location; local build configuration may place it outside `target/`.

## Provision local delivery

Configure the same absolute `RECOUNT_CLAIM_DIRECTORY` on the launcher and collector. Provision its decimal UID child directories before launching workloads:

```sh
sudo install -d -o root -g root -m 0755 /var/lib/recount/claims
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0700 \
  "/var/lib/recount/claims/$(id -u)"
```

Paths must not contain symlinks. The claim root must be owned by root or the caller and must not be group/world writable. Each UID directory must be owned by that UID with mode `0700`. The collector normally runs as root. Never provision a world-writable inbox.

`RECOUNT_CGROUP_SUBTREE` is an optional creation-location hint: an absolute path within the cgroup v2 mount at `/sys/fs/cgroup`, not a filesystem path including that mount prefix. Without a hint, the launcher tries its current cgroup. Provision a writable delegation separately. The kernel enforces creation and placement permissions; the collector has no UID/subtree allowlist.

If the delegation is absent or cannot be created, the launcher warns on stderr and uses ancestry from the launched root. Ancestry cannot recover children that fork and reparent between collector observations. A failure to verify root identity or cgroup placement fails the launch rather than recording unverifiable placement.

## Snapshot and command behavior

The launcher persists revision 1 before releasing the command to execute, then revision 2 with the root's wait result. Its standard streams are inherited directly. Normal exit codes and termination signals are preserved; catchable directed signals are forwarded to the root. Terminal-generated signals already reach the shared foreground process group. SIGKILL cannot be caught; killing the launcher that way may leave only the initial snapshot.

A private exec helper waits on a pipe before executing the workload. Blocking in `Command::pre_exec` would deadlock: `Command::spawn` waits for exec to finish before returning the child PID needed to persist its claim and release the pipe.

The launcher and shared claim crate use `nix` for system calls. Only the launcher's `linux::signals` module permits unsafe code, for raw realtime signal forwarding and restoring default signal disposition before termination. Other launcher modules deny unsafe code; the shared claim crate retains the workspace prohibition.

Only `--name`, `--version` and repeated `--param key=value` options supply metadata. No command arguments or workload environment are captured as metadata. Shell expansion supplies scheduler keys, as in the Slurm example. Parameter keys are unique and stored in bytewise order; values may be empty or contain `=`.

The launcher writes root PID/start ticks and a dedicated-cgroup boolean, not a cgroup path, inode, incarnation or namespace ID. The collector verifies the live root and reads its actual cgroup from procfs. It checks every candidate cgroup member's UID against the claim UID so a forged dedicated flag cannot attribute another user's processes.

No collector connection is needed. Claim files remain available across collector downtime and have no age eviction. The per-UID limits are 1,024 claims and 64 MiB, including temporary replacement bytes. An initial persistence failure prevents command execution. A final persistence failure is reported explicitly on stderr without replacing the command's wait result.

The terminal snapshot records the root's exclusive end and wait result, retaining its last verified live observation. Root exit does not prove that all descendants have ended. A collector that already observed the cgroup continues tracking it, including same-UID descendants that outlive the root, and can remove it after verifying emptiness.

When the collector first discovers a claim after its root has exited, it records lifecycle start/end/exit only. It does not recover cgroup placement or emit retrospective process membership.

The shared [`recount-execution-claims`](../../crates/execution-claims) crate owns the directory protocol and reader API. See the [execution participant contract](../../docs/execution-participants.md#local-launcher-delivery) for ownership and handoff rules.

## Checks

```sh
cargo test --locked -p recount-execution-claims
just linux cargo test --locked -p recount -p recount-execution-claims
```

The writable-cgroup integration check requires an explicitly provisioned disposable test delegation. Run it in a reused Linux environment with `RECOUNT_TEST_CGROUP_SUBTREE` set:

```sh
cargo test --locked -p recount --test launcher \
  delegated_cgroup_placement -- --ignored
```

The ordinary suite exercises ancestry fallback, pre-exec persistence, offline handoff, metadata, streams, signals, wait results and persistence failures.
