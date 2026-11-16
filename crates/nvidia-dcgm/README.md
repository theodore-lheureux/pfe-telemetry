# Optional DCGM acquisition

`recount-nvidia-dcgm` loads the host-installed `libdcgm.so.4` on Linux. NVIDIA libraries and headers are not build dependencies. The collector and all other workspace crates keep `unsafe_code = "forbid"`; only this crate's private `ffi` module allows unsafe calls.

## Safe API

- `Session::open(interval)` owns initialization, a localhost connection only when procfs verifies root socket ownership, or an embedded engine, inventory and bounded watches.
- `Session::sample()` returns a snapshot of owned device UUIDs, optional MIG parent UUIDs and typed field readings with native timestamps and explicit errors. Partial inventory failures remain visible without discarding readable devices.
- `Session` has one process owner. Calls stay on one blocking acquisition worker. Dropping the session releases its watches/groups and connection before unloading the library.

No pointers, native handles, callbacks, arbitrary field IDs or configuration setters escape. Core metrics and profiling use separate watches. Profiling never uses the live-data path. Missing capabilities, cache warm-up, finite blank sentinels, permission failures and invalid native types do not become numeric zero.

The binding supports the reviewed DCGM 4 field-value v2, hierarchy v2 and profiling-group v3 ABIs. An unsupported version is an error, not a guessed layout. See the [collection design](../../docs/nvidia-gpu-collection.md) for units, limitations and privileges.

## Fixture validation

```sh
cargo test --locked -p recount-nvidia-dcgm
```

Linux tests compile a synthetic C shim with the standard C compiler and exercise the actual runtime-loading, watch, field-correlation and cleanup path in isolated child processes. The shim tests ABI boundaries; it does not emulate hardware performance. The published NVIDIA profiling example is identified separately from synthetic native type/status/timestamp wrappers.

The [owner-recorded A10 fixture](../../tests/fixtures/gpu/a10/README.md) adds DCGM 4.8.0 field values and capabilities under Tensor, FP32, FP16 and SM loads. Its capability list omits FP64: the shim rejects attempts to watch 1006, and the session must report it unsupported while retaining valid measured zeros in supported pipes. CLI values are recorded; native ABI wrappers and timestamps are synthetic. No remote host is needed for replay.

### Real library without a GPU

DCGM 4.7.1 was also tested in the reused ARM64 Linux build container without `/dev/nvidiactl`, `/proc/driver/nvidia/version` or `libnvidia-ml.so.1`. Both embedded mode and a foreground standalone host engine started successfully. NVIDIA's core library can continue without NVML; fake entities and cached field injection work without physical counters.

Provide a target-architecture-compatible DCGM 4 runtime through the system loader, then opt in:

```sh
cargo test --locked -p recount-nvidia-dcgm \
  ffi::fake::real_dcgm_fake_entities -- --ignored --exact --nocapture
```

The test refuses a driver/NVML-equipped environment, starts only its own embedded MANUAL engine in an isolated child process, creates a fake GPU, injects SM/pipe ratios, zero and a finite blank, and uses the production batch reader/decoder to verify them. Test/internal APIs are compiled only into the test harness, not exposed by the production safe API. It does not connect to or inject into a site-managed host engine.

The actual probe used checksum-verified `libdcgm`, `nv-hostengine` and `dcgmi` 4.7.1 packages extracted into ignored local state, without system installation or CUDA/driver packages. This validates the real cache/ABI path, not DCP module availability, permissions, multiplexing, GPU activity, MIG hardware or NVML process attribution. Keep the real-hardware gate.

Real GPU validation remains separate. On an owner-provisioned host, the `snapshot` example prints bounded native observations without enrollment or an ingestion backend:

```sh
cargo run --locked -p recount-nvidia-dcgm --example snapshot
```

This command does not create a workload, install software or change accounting/MIG policy. It does create owned monitoring watches and can contend with developer profilers. Obtain hardware authorization before running it. See `NOTICE` and `LICENSE-APACHE` for header attribution; NVIDIA runtime binaries are not redistributed.
