# Recount launcher

`recount run` validates execution labels, sets the command's environment and replaces itself with the command using Unix `exec()`. It needs no collector connection, backend credential, claim directory or cgroup permission.

```sh
cargo build --locked -p recount
recount run --execution "slurm:$SLURM_JOB_ID" \
  --name "Simulation" --version "2026.11" --param mesh=large -- ./simulation
```

Install the built `recount` binary on `PATH` before using this example. Discover its location from Cargo's compiler-artifact JSON rather than assuming `target/`; local build configuration may use another directory.

## Command environment

- `--execution` sets `RECOUNT_EXECUTION` with the validated, project-scoped execution key.
- `--name` sets `RECOUNT_EXECUTION_NAME`.
- `--version` sets `RECOUNT_EXECUTION_VERSION`.
- Repeated `--param key=value` sets `RECOUNT_EXECUTION_PARAMETERS` to a JSON object with unique, bytewise-sorted keys. Values may be empty or contain `=`.

Omitted name/version remove inherited values. No parameters produces `{}`, replacing inherited parameters. Unrelated environment variables are preserved, not captured as metadata. Invalid keys, metadata and duplicate parameters fail before executing the command. See the [participant contract](../../docs/execution-participants.md) for grammar and byte limits.

The command keeps the launcher's PID, standard streams and signal behavior. Exit status passes directly to its caller because there is no waiting parent or helper. Failure to find or execute the command is reported on stderr (status 127 for not found, 126 for permission denied).

## Collection and privacy

The Linux collector reads each process incarnation's environment once, with a 64 KiB bound. It retains only execution labels and the matched variable name; every other variable is discarded and never stored, logged or sent. Children normally inherit labels. Processes that clear their environment, disappear between scans or run entirely during collector downtime may remain unlabelled. No launcher file recovers missed workloads, and no exit status is reported.

Schedulers can label jobs without this launcher: the default mapping recognizes `SLURM_JOB_ID` as `slurm:<id>`. Explicit `RECOUNT_EXECUTION` takes precedence. The collector owns scheduler mapping configuration and process observation.

## Checks

```sh
cargo test --locked -p recount
just linux cargo test --locked -p recount
```

Tests cover input validation, inherited metadata replacement, exact environment serialization, unchanged PID and streams, signals, status and exec failure. The launcher runs on Unix; environment discovery requires the Linux collector.
