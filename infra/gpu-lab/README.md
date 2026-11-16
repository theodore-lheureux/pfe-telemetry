# NVIDIA GPU validation on Google Cloud

Validate an **already-running**, owner-provisioned Google Cloud VM in `recount-cloud`: one NVIDIA L4, T4 or A10, x86_64 Ubuntu 22.04, with its NVIDIA driver preinstalled. The runner copies the current source snapshot, builds natively on the instance, installs DCGM 4 and its proprietary profiling packages, enrolls a dedicated project's collector, and runs capability-selected compute-pipe loads. It never provisions, starts, stops or deletes cloud resources.

## Instance requirements

- Prefer `g2-standard-4` with one L4; `n1-standard-4` with one T4 is also supported. Use an x86_64 Ubuntu 22.04 image with a working NVIDIA driver, `nvidia-smi`, and a reported CUDA user-mode driver major of 12 or 13. Do not use a container-only image. The runner does not install or replace the driver.
- Use a boot disk of **60 GB or larger**, with at least **20 GiB free** before the build; the build refuses less free space. Four vCPUs and at least 15 GB RAM suit the four-job native build.
- Add the configured public key to instance metadata for user **`recount`**, with passwordless `sudo`. If OS Login is enabled, provision equivalent access explicitly rather than assuming instance metadata keys are honored. The harness changes neither IAM nor SSH metadata.
- Allow inbound **TCP 22 only**, restricted to the Mac's source IP. No inbound application, ingestion, DCGM or database ports are needed. Permit outbound access to Ubuntu, NVIDIA, Rust and crates.io package endpoints over HTTP/HTTPS, plus DNS. Keep the guest clock synchronized.
- Set the automatic maximum run duration when provisioning. Allow at least 60 minutes for build and validation bounds plus transfer/setup; 90 minutes leaves diagnosis time. These are timeout allowances, not measured workload timings. The runner never changes the VM deadline or stops the VM.
- Obtain the SSH server's **SHA256 host-key fingerprint from GCP guest attributes** over the coordinator's trusted channel. Pass that fingerprint to the runner; do not authorize an unverified `ssh-keyscan` result.

## Prepare the Mac

1. Keep the existing PostgreSQL, Kafka and ClickHouse stack running. Run the web application, ingestion API and normalizer from this checkout with matching signing keys and telemetry reader configuration. Apply the reviewed Drizzle migrations through `just db-migrate`, including `0026_gpu_enrollment_default`. The runner does not migrate, rebuild, recreate or reset the local stack.
2. Copy `infra/gpu-lab/config.example.json` to ignored `.state/gpu-lab/config.json`. Set the SSH identity, existing organization/admin IDs, existing service containers and binary output directory. No local Linux builder or prebuilt binary is needed. Binaries downloaded from each run go into `<bin_directory>/<execution>/`.

   `database_env` must identify an ignored, private environment file with a **host-reachable** `DATABASE_URL` for the same application database as the web application. Project creation uses the application's authorization and domain functions. No credentials enter committed configuration or the copied source archive.

3. **Optional:** sign into the local web application as an existing organization owner/admin and save a Playwright storage state. Use the same origin throughout, including `127.0.0.1` versus `localhost`:

   ```sh
   umask 077
   node node_modules/@playwright/test/cli.js codegen \
     --save-storage=.state/gpu-lab/browser.json http://127.0.0.1:3001
   ```

   Close the browser after signing in and set `browser_state` to that file. Keep it private. Browser capture uses host Node and the existing Playwright installation; it neither creates users nor bypasses authentication. Leave `browser_state` null or omit it to skip capture cleanly and verify the supplied project/execution URLs yourself. A configured but missing state file is an error, not a silent skip.

4. Wait for the web application and ingestion API to be Docker-healthy, the normalizer to report readiness, and migration `0026` to be applied, then validate configuration without contacting an instance:

   ```sh
   python3 infra/gpu-lab/run.py --check-config
   ```

   This gate checks the existing container health, host loopback ports, ClickHouse read access, the migration hash, and the configured actor's canonical organization membership in a read-only PostgreSQL transaction. It does not create a project, apply a migration or repair any service.

   The approved `normalizer_readiness: "native"` setting permits the normalizer's own `state=ready checks=initial_snapshot offset_reset=earliest` signal when it has no Docker healthcheck. The probe reads only logs since the current container start and rechecks that the container did not restart or stop. A configured unhealthy Docker healthcheck is never bypassed. This confirms startup preflight, not continuous broker health; mandatory ClickHouse verification checks delivery during the actual run. Without that setting, all three services must be Docker-healthy.

5. Once the owner launches the instance, obtain its SHA256 host-key fingerprint from the coordinator's GCP guest-attribute check. The runner compares scanned public-key bytes against that fingerprint, writes only the matching key to the run's private `known_hosts`, and uses plain SSH/SCP with `StrictHostKeyChecking=yes`, only the configured identity, and no agent forwarding. A missing or mismatching fingerprint stops the run before authentication. It refuses an effective SSH server `GatewayPorts` setting other than `no` before opening reverse forwards.

## Run after launching the instance

From this worktree on the Mac:

```sh
python3 infra/gpu-lab/run.py INSTANCE_IP \
  --host-key-fingerprint 'SHA256:FINGERPRINT_FROM_GCP_GUEST_ATTRIBUTES'
```

The runner uses `.state/gpu-lab/config.json`; pass `--config PATH` for another ignored configuration. You may store the verified fingerprint in its `host_key_fingerprint` field instead of passing the option. It forwards remote `127.0.0.1:43170` to the local ingestion port and remote `127.0.0.1:30070` to the local web port. No VPC firewall changes, public ingestion endpoints, gcloud/IAP transport or database tunnels are used.

The first remote mutation copies a private archive of the exact current checkout, including tracked edits and untracked, nonignored files. Deleted files are omitted. Git internals, ignored environment files, node modules and local caches are not transferred. Symlinks and special files are rejected. Per-file hashes and executable modes bind the archive to `snapshot.json`; SSH bootstrap checks both archive and manifest hashes before extraction.

The native build:

- Requires x86_64 Ubuntu 22.04 and exactly one supported GPU before installing build prerequisites. Multi-GPU output and other GPU models fail closed.
- Installs Ubuntu's build essentials, pkg-config, CA certificates, curl and Python. Downloads checksum-pinned rustup `1.28.2` from the official archive and installs stable Rust **`1.99.0`** with the minimal profile.
- Builds as the unprivileged SSH user, never as root. Rustup, Cargo downloads and compiler outputs stay in the owned staging directory; no existing toolchain or cache is cleaned or overwritten.
- Uses `cargo +1.99.0 build --locked --release --target x86_64-unknown-linux-gnu` for the collector and `recount`. Verifies the entire source snapshot before and after compilation, discovers executables from Cargo's artifact JSON, and writes the source/commit/toolchain identity plus both executable SHA-256 hashes to `build.json`.
- Downloads the binaries and receipt to the Mac and verifies the expected snapshot, pinned toolchain, x86_64 ELF headers and hashes before enrollment. A changed local checkout aborts the run. Native builds are bounded to 40 minutes; the source, logs and build directory remain for diagnosis.

Only after the build passes does the runner issue a short-lived, single-node enrollment key. The remote validation script:

- Requires exactly one NVIDIA L4, T4 or A10 on Ubuntu 22.04 with host PID visibility.
- Reads the CUDA user-mode driver major from `nvidia-smi -q`, then installs `datacenter-gpu-manager-4-cuda<major>`, `datacenter-gpu-manager-4-proprietary` and `datacenter-gpu-manager-4-proprietary-cuda<major>` from NVIDIA's signed Ubuntu repository. It refuses an installation plan that removes packages or replaces the driver. See NVIDIA's [DCGM installation instructions](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/getting-started.html#installation).
- Starts the installed root-owned DCGM service and records **`dcgmi profile -l`**. `capabilities.json` derives offered and unavailable fields from that host's output. No GPU model determines FP64 support. The Mac independently re-parses the saved output before verifying ClickHouse evidence.
- Runs the collector as root with the existing host-visibility assertion. A private, root-owned participant configuration shortens fact heartbeats to five seconds.
- Runs a 30-second load for each offered Tensor, FP64, FP32 and FP16 pipe under one `recount run --execution gpu-e2e-<UTC-date>-<random>` process. At least one compute pipe must be offered. Unoffered pipes are never loaded or assumed to be zero. `--no-dcgm-validation` prevents the generator from managing profiling watches while the collector samples.
- Bounds remote execution to seven minutes. Stops only its collector, removes only its enrollment/private node keys, and revokes its dedicated enrollment key and enrolled node. The project, samples, remote queue and logs remain for inspection.

## Evidence and pass conditions

Evidence is private under `.state/gpu-lab/gpu-e2e-*`. It includes the source archive/manifest, build log/receipt, dedicated project and execution URLs, hardware/package/capability logs, workload phase times, collector logs, node identity, ClickHouse points and optional browser screenshots/text. Enrollment keys, node private keys and browser cookies are not copied into evidence. Do not publish the directory without reviewing source, host and process identifiers.

The ClickHouse verifier requires:

- GPU UUID, positive device utilization and framebuffer use.
- Positive observations for every offered compute pipe, including FP64 when offered. Other offered profiling fields need either a reading or an explicit unavailable status; an offered field alone does not guarantee a physical counter observation.
- Positive process GPU memory and utilization points covered by the labelled execution's latest, nonretracted membership facts. Membership intervals are tested as a set, not joined in a way that multiplies points.
- For **every unoffered profiling field**, no scalar point, including zero, and an explicit unsupported read status. The saved A10 fixture still expects FP64 to be unavailable; T4/L4 expectations follow their live capability catalogue instead.

When configured, authenticated browser capture opens the execution page and existing Explore tables for device utilization, per-pipe activity, execution-filtered process memory/utilization and pipe read statuses. It requires populated result rows and the capability-selected pipe/execution groups. Device pipe activity is node context, never attributed per-process pipe usage. `verification.json` records mandatory ClickHouse results and a browser result of `passed` or `skipped`; skipping never claims UI verification.

If a check fails, inspect the retained logs and `points.jsonl`; do not reset shared state or infer zero from missing data. The scripts are prepared for this run, not evidence that hardware validation has already passed. MIG, NVLink, overhead and additional GPU/driver combinations remain separate validation work. Stop or terminate the instance yourself when finished.

## Local checks

These commands do not contact the instance or alter the stack:

```sh
python3 -m unittest discover -s infra/gpu-lab -p 'test_*.py'
bash -n infra/gpu-lab/remote.sh
bash -n infra/gpu-lab/remote-build.sh
bash -n infra/gpu-lab/host.sh
node --check infra/gpu-lab/capture.mjs
bun --no-env-file run tsc --project infra/gpu-lab/tsconfig.json
```
