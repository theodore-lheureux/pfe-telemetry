# NVIDIA GPU collection

The collector uses dynamically loaded DCGM for per-GPU compute-pipe, SM and core telemetry. One private binding crate has the owner-approved unsafe FFI exception; every other crate retains [`Cargo.toml`](../Cargo.toml)'s `unsafe_code = "forbid"` policy. DCGM remains the only pipe/SM profiling backend. The owner separately approved a small safe NVML supplement for actual process memory/utilization, without enabling persistent accounting. Owner-recorded A10 vendor telemetry supplies real-hardware fixtures. A subsequent owner-run L4 validation passed the native collector-to-ClickHouse path, including NVML process attribution.

## Why compute-pipe telemetry requires DCGM on T4 and L4

Compute-unit telemetry means FP32, FP64, FP16 and Tensor-pipe activity, SM activity and SM occupancy. Conventional GPU utilization is not a substitute: it measures time with kernels executing, not which execution pipes are active.

NVIDIA's [NVML header](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h#L14974-L15084) explicitly limits `nvmlGpmMetricsGet`, sample acquisition and support queries to **Hopper or newer fully supported devices**. Its [GPM metric enum](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h#L14457-L14474) includes comparable SM, occupancy, Tensor and non-Tensor FP64/FP32/FP16 percentages. NVIDIA identifies [T4 as Turing](https://www.nvidia.com/en-us/data-center/tesla-t4/) and [L4 as Ada Lovelace](https://www.nvidia.com/en-us/data-center/l4/); neither meets that GPM architecture requirement.

NVIDIA's [DCGM profiling guide](https://docs.nvidia.com/datacenter/dcgm/latest/learn/modules/profiling.html#multiplexing-of-profiling-counters) explicitly shows T4's supported metric groups, including SM activity, occupancy, Tensor and FP32 in group A.1, FP64 in A.2 and FP16 in A.3. Query the runtime capability catalogue on each GPU; this example is not a guarantee that every installed driver/module/device exposes every field. L4 support also requires runtime probing and hardware validation.

DCGM profiling is therefore required for the target T4/L4 compute-pipe requirement. Do not implement a second GPM profiling backend in this change. If DCGM is absent, report device profiling/core collection as unavailable while preserving CPU and supported process collection. NVML is used only for process metrics, never to pretend to replace missing pipe counters.

## Integration options

The inspected sources are DCGM `v4.7.0` (`9fae2867e6e5264fa0fca22a07dc898d591baa21`), dcgm-exporter `4.9.0` (`4e663a526c4624ad0e18ad816f09b7be2c5348a7`), NVIDIA's NVML header (`5e992702f9f516e8db7a0c34d3e462a87f48339d`) and registry-checked `nvml-wrapper` `0.13.0`. They establish API contracts, not a validated HPC deployment/version matrix ([DCGM API](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h), [NVML header](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h), [safe wrapper](https://docs.rs/crate/nvml-wrapper/0.13.0/source/src/lib.rs)).

| Option                               | HPC availability, root and version coupling                                                                                                                        | Overhead and lifecycle                                                                                         | Multi-GPU, MIG and process attribution                                                                                           | Licences and no-GPU behavior                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Embedded `libDCGM`                   | Separate runtime/modules, not driver-provided. Some non-root reads; profiling needs authorized counters. Exact library ABI and driver/module compatibility matter. | One in-process engine; live driver queries plus optional watches/background work. No universal overhead bound. | Multiple devices/typed MIG entities; board data is not instance data. PID/job statistics require advance watches and boundaries. | Source/headers Apache-2.0, not every proprietary package. Empty discovery differs from load/init failure.                    |
| Standalone `nv-hostengine` client    | Installed client library and accessible site-owned service; client version at least engine version. Engine credentials govern capabilities.                        | Shares sampling across clients; native client still runs in-process. Connect once, not per scan.               | Same hardware limits; rediscover IDs on reconnect. Watches do not establish process/execution membership.                        | Same DCGM distinction. Service failure is not absent hardware.                                                               |
| dcgm-exporter scrape                 | Explicitly available endpoint only; DCGM-equipped HPC nodes need not run exporter. Still needs driver/DCGM access and profiling permissions.                       | Extra service and HTTP/text parsing; inspected collection default 30 s, independent of scrape cadence.         | Device/MIG data; HPC job labels copy device samples. Optional process path uses NVML.                                            | Source Apache-2.0; NGC adds NVIDIA terms. Prometheus drops native timestamps. Optional absence must not stop CPU collection. |
| Safe NVML                            | Normally driver-provided; device/container permissions apply. GPM requires Hopper or newer and cannot meet T4/L4 pipe coverage.                                    | Small core-gauge fallback is possible; a second profiling backend is unnecessary.                              | Multi-GPU UUIDs and supported process memory; no conventional MIG process utilization.                                           | Wrapper MIT OR Apache-2.0; NVIDIA header/runtime terms remain separate.                                                      |
| DCGM primary, optional core fallback | Selected: native DCGM for profiling and core metrics. One binding-crate unsafe exception is approved.                                                              | Prefer existing local engine, otherwise one embedded lifetime; no duplicate profiling backend.                 | GPU/MIG profiling; only genuinely process-scoped public reports can be attributed to processes.                                  | Load host-installed binaries; bundle none. Missing DCGM never fails CPU collection.                                          |

NVIDIA documents operation modes, reduced non-root capabilities, profiling privileges and shared watches. A SONAME does not prove client/engine compatibility ([modes](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/getting-started.html), [exporter compatibility/cadence](https://docs.nvidia.com/datacenter/dcgm/latest/installation/install-dcgm-exporter.html), [watch sharing](https://docs.nvidia.com/datacenter/dcgm/latest/learn/core-services/fields-and-watches.html)). NVML normally accompanies the driver but is not guaranteed in every site's package/container exposure ([NVIDIA overview](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/README.md#overview), [container controls](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)).

Safe NVML plus an existing dcgm-exporter was considered but not selected. Do not assume exporter availability or discover it by remote scanning. Its inspected Prometheus renderer omits `TimestampMs`, losing native sample time; scrape time is not DCGM collection time. Exporter OTLP output is a separate unevaluated integration ([renderer](https://github.com/NVIDIA/dcgm-exporter/blob/4e663a526c4624ad0e18ad816f09b7be2c5348a7/internal/pkg/rendermetrics/render_metrics.go#L257-L310), [HPC sample copying](https://github.com/NVIDIA/dcgm-exporter/blob/4e663a526c4624ad0e18ad816f09b7be2c5348a7/internal/pkg/transformation/hpc.go)).

DCGM/exporter source licences do not cover every proprietary runtime module, driver or image. Preserve applicable notices, including NVML's documentation/comment notices if copying header declarations; review actual redistributed artifacts separately ([DCGM licence](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/LICENSE), [exporter licence](https://github.com/NVIDIA/dcgm-exporter/blob/4e663a526c4624ad0e18ad816f09b7be2c5348a7/LICENSE), [image terms](https://github.com/NVIDIA/dcgm-exporter/blob/4e663a526c4624ad0e18ad816f09b7be2c5348a7/README.md#L80-L84), [wrapper licence](https://docs.rs/crate/nvml-wrapper/0.13.0/source/Cargo.toml), [NVML notice](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

## Automatic collection must not change the node

Load `libdcgm.so.4` and, for process collection, `libnvidia-ml.so.1` through `nvml-wrapper`'s safe builder. Neither NVIDIA runtime is required at build time. Do not depend on development `.so` symlinks, scan the working directory or try arbitrary library majors. Keep owners alive until native handles and cleanup finish; privileged deployments control loader paths ([DCGM runtime loader](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgm_stub/dcgm_stub_static.c#L80-L145), [SONAME](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgm_stub/version_config.h.in#L1), [safe NVML builder](https://docs.rs/crate/nvml-wrapper/0.13.0/source/src/lib.rs)).

Try the existing administrator-owned host engine at `127.0.0.1:5555` with a 500 ms connection timeout only when procfs reports root ownership for every eligible TCP listener. Check the kernel socket UID in `/proc/self/net/tcp` and `tcp6`, including wildcard listeners. Missing, non-root or undeterminable ownership selects an embedded engine without contacting the listener. If that automatic connection is unavailable, own one embedded `AUTO` engine for the collector lifetime. Add no endpoint configuration or remote discovery. Use `persistAfterDisconnect=0`; remove only owned watches/groups, disconnect or stop the owned engine, then perform process-owned shutdown. Rediscover after reconnect; engine-local IDs are not durable identities ([lifecycle](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h#L47-L227), [connection parameters](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L560-L609)).

Never install packages, start external services, escalate privileges, enable accounting, change persistence/MIG/counter modes, reset hardware or pause/resume another profiler. Put optional work off the CPU critical path with bounded queues, retries/backoff and stale-result handling. A connect timeout does not bound every driver call; joining a blocked thread is not cancellation. A hung optional worker must not block subsequent CPU scans.

**Ordinary absence adds no baseline points and produces no warning.** An unloadable runtime and successful zero-device enumeration remain distinct outcomes; the latter proves only empty visible coverage. When the runtime cannot load, procfs, the NVIDIA control device and bounded PCI vendor/class discovery identify visible NVIDIA hardware for an unavailable-backend diagnostic. The loader does not distinguish every missing-library, dependency or architecture failure. Initialization, permission, symbol, native version and lost-device failures retain bounded error categories, not fabricated zero-device counts. Continue per device when another fails, and never stop CPU/process collection for an optional backend failure ([NVML errors/enumeration](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h), [DCGM enumeration](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h#L340-L458)).

## Preserve measurement meaning, native time and missingness

Use bounded DCGM watches for separate profiling and core field groups, preserving native type/status/time. Request supported profiling fields, then read the cache with flags `0`. The only live field queried is UUID `54`; never probe profiling through the live path. Instrumentation scope `recount.collector.dcgm` uses the current collector package version. Never substitute conventional utilization for a missing profiling ratio ([ordinary live path](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/src/DcgmCacheManager.cpp#L7428-L7595), [field definitions](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h)).

Acquisition runs on a separate blocking worker with one queued request and one response. Its interval is at least one second, or the configured collector interval when slower; GPU resource interval metadata reports that cadence. CPU scans consume available results without waiting for native calls. Stale results, repeated field timestamps and old collection-epoch responses cannot become fresh measurements. Native failures retry after 30 seconds. Inventory refreshes every 30 seconds, preserving unchanged device watches. A successful empty initial inventory disables this optional worker until collector restart.

### First-class compute-pipe and SM metrics

All ratios are Float64 gauges with unit `1`, bounds `[0,1]` and start timestamp `0`. Activity uses the metric definitions to format these ratios as percentages with at most one decimal (`0.25` means `25%`), retaining the exact stored value in the tooltip. Unit `1` remains the correct stored ratio unit; `%` would require scaling the measurement to 0–100. No rate calculation, FLOPS conversion or sum-to-100 assumption applies.

| Metric                        | Native field                               | Meaning and dimensions                                                                                         |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `recount.gpu.engine.activity` | `1001` / `DCGM_FI_PROF_GR_ENGINE_ACTIVE`   | Graphics/compute-engine active-time fraction over the interval.                                                |
| `recount.gpu.sm.activity`     | `1002` / `DCGM_FI_PROF_SM_ACTIVE`          | Fraction of time with at least one active warp, averaged over SMs. Waiting warps still count.                  |
| `recount.gpu.sm.occupancy`    | `1003` / `DCGM_FI_PROF_SM_OCCUPANCY`       | Resident warps relative to the theoretical concurrent-warp maximum. Not achieved compute throughput.           |
| `recount.gpu.pipe.activity`   | `1004` / `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` | `gpu.pipe=tensor`; Tensor-pipe active-cycle fraction.                                                          |
| `recount.gpu.pipe.activity`   | `1006` / `DCGM_FI_PROF_PIPE_FP64_ACTIVE`   | `gpu.pipe=fp64`; FP64-pipe active-cycle fraction.                                                              |
| `recount.gpu.pipe.activity`   | `1007` / `DCGM_FI_PROF_PIPE_FP32_ACTIVE`   | `gpu.pipe=fp32`; FMA-pipe activity, which can include integer instructions. Not a pure FP32 instruction count. |
| `recount.gpu.pipe.activity`   | `1008` / `DCGM_FI_PROF_PIPE_FP16_ACTIVE`   | `gpu.pipe=fp16`; non-Tensor FP16-pipe activity, separate from Tensor activity.                                 |
| `recount.gpu.dram.activity`   | `1005` / `DCGM_FI_PROF_DRAM_ACTIVE`        | Fraction of cycles with device-memory traffic; not allocation or bytes/second.                                 |

The external macro spellings above match the existing vendor catalogue; current NVIDIA headers also expose newer names for the same numeric IDs. Add owned Linux catalogue entries rather than duplicate-exporting old/new vendor aliases. Keep existing external-adapter fixture mappings intact ([native definitions and aliases](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h), [metric meanings](https://docs.nvidia.com/datacenter/dcgm/latest/learn/modules/profiling.html#metrics)).

T4's A.1 metrics can run together, but requesting FP64 and FP16 as well requires multiplexing across A subgroups. Let DCGM manage supported multiplexing at one second or the existing interval when slower. Record compatible-group/multiplexing provenance. NVIDIA warns that high-frequency multiplexing can return zeros: retain valid vendor observations without claiming that a zero proves an idle pipe. Unsupported, paused, blank and failed reads remain unavailable. Do not change global profiler pause/resume state.

### Core and process metrics

The catalogue entries below are **gauges with start timestamp `0`**. Ratios use unit `1` and range `[0,1]`.

| Metric                          | Unit / scalar     | Scope and meaning                                                                                                                       |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `recount.gpu.utilization`       | `1` / double      | GPU conventional kernel-executing time fraction, not SM active/occupancy or theoretical capacity.                                       |
| `recount.gpu.memory.activity`   | `1` / double      | GPU memory read/write time fraction, not allocated-memory fraction or bandwidth.                                                        |
| `recount.gpu.memory.total`      | `By` / int64      | Physical GPU framebuffer capacity. Instance capacity is not exported by this implementation.                                            |
| `recount.gpu.memory.used`       | `By` / int64      | Source-reported framebuffer use; preserve API/reserved-memory meaning.                                                                  |
| `recount.gpu.power`             | `W` / double      | Physical GPU; source-dependent averaged/instantaneous sampling.                                                                         |
| `recount.gpu.temperature`       | `Cel` / int64     | Physical GPU sensor; never invented for MIG.                                                                                            |
| `recount.gpu.clock`             | `Hz` / int64      | Supported current clock; `gpu.clock.domain=sm/memory`, not requested/maximum clock.                                                     |
| `recount.gpu.ecc.errors`        | `{error}` / int64 | Physical GPU aggregate lifetime snapshot; `gpu.error.type=corrected/uncorrected`, `gpu.error.scope=aggregate`; **not a rate counter**.  |
| `recount.gpu.xid.last`          | `{error}` / int64 | Source-reported XID **code**, not count; no cached sample means unavailable. A native explicit zero remains distinct from missing data. |
| `recount.gpu.pcie.throughput`   | `By/s` / double   | Physical GPU profiling rate; `gpu.io.direction=tx/rx`, GPU perspective.                                                                 |
| `recount.gpu.nvlink.throughput` | `By/s` / double   | Physical GPU aggregate rate; `gpu.io.direction=tx/rx`; no protocol-header coverage promise.                                             |

Convert percent `/100`, NVML milliwatts `/1000`, DCGM MiB `×1,048,576` and MHz `×1,000,000`, with checked arithmetic. Keep native integers exact, including above `2^53`; do not route them through double/JavaScript numbers. Unsigned values beyond int64, or native integer rates not exactly representable by the proposed double, become out of range. Validate valid signed temperatures rather than imposing a blanket nonnegative constraint ([NVML units](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h), [DCGM units/types](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h)).

Power averaging depends on hardware/API. Conventional utilization, SM active/occupancy, memory activity, allocated bytes and DRAM profiling activity remain separate. Existing `DCGM_FI_PROF_*` entries in [the catalogue](../crates/telemetry-validation/src/catalogue.rs) remain external-adapter fixtures, while the owned entries above make collector profiling first-class. Current gauges do not imply a future NVML used-memory fallback has identical reserved-memory semantics ([power behavior](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceQueries.html), [memory definitions](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

Read supported aggregate ECC fields and XID field `230` through DCGM watches. Preserve the last observed XID code with its native collection time; it is not an error count or complete event history. Begin unavailable until a supported sample exists. Do not read kernel logs or fabricate zero on an empty cache ([DCGM field definitions](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h)).

Core gauges are physical-device measurements in this implementation. Verified MIG compute instances publish supported profiling fields `1001–1008`; board-wide core gauges and PCIe/NVLink rates stay unavailable on children. This avoids silently copying parent values. Per-instance framebuffer collection remains unimplemented.

### Throughput uses the profiling watch path

Fields `1009–1012` are interval-average **bytes/second**, not cumulative bytes. Include supported rates in owned profiling watches and cache reads with flags `0`; **never send any profiling field through `LIVE_DATA`**. Core and profiling watches use at least one second, three retained samples and a maximum age of three acquisition intervals. First samples can be unavailable. Remove only owned state ([watch API](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h#L1069-L1115), [live profiling dispatch](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/src/DcgmCacheManager.cpp#L15930-L16064)).

Contention/unsupported/permission outcomes mean unavailable, not fabricated rate. Never pause/resume other profilers or reset/configure deprecated NVML counters. NVML PCIe `KB/s` does not establish decimal KB; safe-wrapper NVLink fields lack a documented rate and arbitrary link/aggregate scope. Neither is an automatic fallback. DCGM header/guide disagree about NVLink header inclusion: promise rate semantics only ([profiling constraints](https://docs.nvidia.com/datacenter/dcgm/latest/learn/modules/profiling.html), [DCGM rate definitions](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h#L2613-L2690), [NVML counters](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h), [wrapper scope](https://docs.rs/crate/nvml-wrapper/0.13.0/source/src/device.rs)).

### Unavailable readings never become measured zero

Reject DCGM finite blanks before conversion: int64 `>=0x7ffffffffffffff0`, double `>=2^47`, string blank markers, plus nonfinite values. Validate type/per-field status before inspecting native values; successful calls can contain blank fields. Honor all NVML result layers/sentinels, including unavailable process memory (`u64::MAX`) ([DCGM blank predicates](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L40-L156), [NVML sentinels](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

Reuse read statuses: `0` success, `1` unsupported, `2` permission denied, `3` disappeared, `4` read failed, `5` out of range, `6` temporarily unavailable. Keep valid zero, omit unavailable scalar points and preserve existing no-recorded flag handling. No verified device/process identity means no invented per-resource status. Distinguish scalar no-data, discovery/init failure and physical absence ([missing readings](telemetry-contract.md#missing-readings)).

DCGM timestamps explicitly use Unix microseconds: require valid positive time, checked-multiply by `1000`, preserve through retries and suppress repeated cached samples. NVML field-value time explicitly uses epoch microseconds; untimestamped scalar gauges use collector observation time with truthful provenance. Native timestamp does not establish an averaging window, atomic snapshot or clock accuracy; do not manufacture gauge origins ([DCGM ABI/time](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L2274-L2355), [NVML timestamp distinctions](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

## Keep GPU identity and execution attribution separate

Use host-local physical UUID under the enrolled root grant, not NVML/DCGM/CUDA ordinal; index/PCI bus ID is metadata. MIG resources require verified compute-instance UUID, parent UUID and available typed GI/CI coordinates. Validate the current lifetime, invalidate handles/cursors on reconfiguration and enumerate sparse slots fully. Engine-local/recycled small IDs do not establish identity ([MIG hierarchy](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L751-L806), [NVML discovery](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

Do not copy parent board power/temperature/traffic onto MIG resources: returned entity labels do not guarantee independent scope. Conventional MIG process utilization remains unavailable; report supported memory without duplicating shared GI memory across CIs or summing parent/child totals. Never infer process watts ([parent remapping](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/src/DcgmCacheManager.cpp#L7530-L7590), [shared GI memory](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/getting-started-with-mig.html#compute-instances), [process restrictions](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

### Process identity must bracket the actual GPU read

Retain the CPU process identity `(boot, verified PID namespace, PID, start ticks)` and resource ID unchanged. Anchor procfs identities before the **actual GPU query**, then verify the same incarnations afterward. A pre-query table/post-query validation can cover a batch; first resolving a PID after the query cannot validate an earlier observation. Deduplicate overlapping compute/graphics memory rows ([identity](../apps/collector/src/identity.rs), [process sampler](../apps/collector/src/linux/process.rs), [procfs reuse behavior](https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories)).

Require the existing `RECOUNT_COLLECTOR_VISIBILITY=host` assertion and verified host procfs/PID namespace for host-PID joins, not a new setting. Library access does not prove host visibility. Never equate container-local or vGPU guest PIDs with host processes; restricted deployments retain device metrics but omit uncertain joins ([visibility contract](../apps/collector/README.md#configuration), [NVML PID/vGPU structures](https://github.com/NVIDIA/go-nvml/blob/5e992702f9f516e8db7a0c34d3e462a87f48339d/gen/nvml/nvml.h)).

A current procfs pair alone cannot validate a historical process summary. DCGM reports identify processes by numeric PID and give report start/end times, not Linux start ticks. Emit a process point only when the report window can be tied to retained, verified incarnation evidence; otherwise report unavailable. Do not derive a precise Unix process start from `btime`/ticks or attach a lifetime summary to the time of the latest poll. Hardware validation must establish native clock/window behavior ([DCGM PID report](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L2725-L2786), [existing timestamp constraint](../apps/collector/src/linux/process.rs)).

Keep native sample/history state per device and metric, with process incarnation where applicable. Deduplicate repeated samples, retain all records sharing a timestamp and never advance a cursor to wall time on an empty or failed fetch. Missing process readings are not zero or proof of exit. Reset uncertain attribution on clock, driver or host-engine lifetime changes.

### Profiling attribution is limited to the scope NVIDIA exposes

The public `dcgmPidSingleInfo_t` and `dcgmGpuUsageInfo_t` report structures contain general process SM/memory percentages, memory high-water marks and other management summaries. They contain **no FP32, FP64, FP16, Tensor-pipe, profiling SM-activity or profiling occupancy fields**. Per-pipe PID/job attribution is therefore unsupported by the inspected public DCGM API, including on T4/L4. Do not add invented process pipe metrics, divide device activity among PIDs or treat a single currently visible process as proof of exclusive interval ownership ([PID and job structs](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L2725-L2877)).

DCGM lifetime process summaries are not selected here. `dcgmGetPidInfo` requires prior statistics collection and verifiable report-window/incarnation correlation; lack of retained data is unavailable, not zero. Instead use the approved safe NVML process supplement without enabling persistent accounting watches or driver accounting mode. Do not bind internal-only fields `210/211/220/221` as a substitute for a supported public interface ([statistics prerequisites and lifetime](https://docs.nvidia.com/datacenter/dcgm/latest/learn/core-services/process-and-job-statistics.html), [public API](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h#L1338-L1393), [internal field warning](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_fields.h#L797-L818)).

DCGM job summaries require explicit GPU allocation groups and start/stop boundaries supplied by a scheduler. Environment labels do not provide that allocation/exclusivity evidence, so do not create DCGM jobs from execution keys. GPU/MIG pipe readings remain node context for execution views, not attributed usage. MPS server/client and vGPU guest-PID ambiguity remain unavailable rather than inferred.

### Existing membership facts cover GPU process points

One multi-GPU process keeps one resource identity; `gpu.uuid` distinguishes its GPU point dimensions. Existing process membership facts suffice. Execution reads select latest nonretracted facts and **semijoin** project, node/source, process resource and covered time without multiplying points for overlapping facts. Device-wide GPU readings remain node context, not execution usage.

The execution-attribute passages in [the semantic model](telemetry-semantic-model.md) are obsolete relative to [execution participants](execution-participants.md#clickhouse-participants). **Add no execution resource attribute, point dimension, `recount.execution.id` or storage column.** Environment-label participant discovery stays separate from hardware sampling.

## Implementation and validation stay within existing boundaries

Existing GPU kind and OTLP/ingestion/Kafka/normalizer/ClickHouse types need no new protocol, storage table or service. Proposed work is limited to identity resolution, collection, catalogue/grants and shared queries ([point contract](telemetry-point-contract.md), [current Linux parser](../crates/telemetry-validation/src/linux_adapter.rs)).

| Proposed files/boundary                                                                          | Responsibility                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/collector/src/linux/gpu.rs` and focused `gpu/` modules                                     | Safe fixture-driven `Backend` returning owned inventory/readings/status; split mapping, process windows and orchestration. No raw pointers.                |
| Private `crates/nvidia-dcgm/`, approved exception                                                | Narrow FFI layout/loader/session/watch modules; no arbitrary native field API. Keep each new implementation file below 300 lines.                          |
| Existing collector `linux.rs`, `linux/process.rs`, `identity.rs`, `metrics.rs`, `diagnostics.rs` | Optional worker and actual-read brackets; reuse helpers, preserve CPU/process identity and no-GPU baseline.                                                |
| Validation `linux_adapter.rs`, `policy.rs`, `catalogue.rs` and fixtures                          | Host-local GPU/MIG resolution, exact metric semantics and explicit kind grants; preserve external DCGM fixture contracts.                                  |
| Web collector contracts/validation and `db/collectors-schema.ts`                                 | GPU permission in new defaults only; no widening of old/explicit policy.                                                                                   |
| Existing web presentation                                                                        | Friendly EN/FR metric names and shared UCUM formatting only. The templates rework is already on this base, so no GPU template, page or component is added. |

The approved exception applies to **one private crate only**; do not weaken global lints. Its minimal safe API exposes an owned session with automatic initialization, inventory, a fixed metric-set watch and validated snapshots/statuses. No raw pointers, handles, unions, callbacks, arbitrary field IDs, configuration setters or job controls escape. Check exact C signatures, native integer enum/status storage and `uintptr_t` handles. Own library/init/session cleanup, serialize calls, initialize aligned bounded buffers and assert supported Linux ABI layouts. `dcgmFieldValue_v2` is **4128 bytes**, including a 4096-byte union. Correlate `(entity group, entity ID, field ID)`, never zip output against input order; validate types, versions, statuses, strings and capacities. A post-call version check cannot fix a wrong output stride. Header-only layout checks are not hardware validation ([batch contract](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_agent.h#L1267-L1291), [ABI layout](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_structs.h#L2274-L2355)).

### Grants must protect the unchanged CPU/process batch

Change new Linux enrollment defaults from process/container `[4,6]` to GPU/process/container `[3,4,6]`; never auto-widen existing keys/nodes or overwrite explicit lists. **Suppress GPU resource emission and GPU-feature points/statuses when the current enrolled token does not permit local GPU kind under the Linux adapter.** Optional GPU collection must not cause whole-batch rejection of CPU/process data. Locally decoded grants are conservative emission gating only, never authority; ingestion remains canonical authorization. Reevaluate on token renewal without rewriting immutable queued batches.

If changing the database default, use one generated/reviewed Drizzle migration for that default only, not a grant backfill or another runner. Update enrollment/token/auth fixtures together ([defaults](../apps/web/src/collectors/contracts.ts), [explicit-list handling](../apps/web/src/collectors/validation.ts), [database default](../apps/web/src/db/collectors-schema.ts), [root grants](telemetry-point-contract.md#resource-grant-interface)).

Use shared gauge calculations, not `rate` on throughput gauges, ECC snapshots or XID codes. Display XID codes with `last`, not an average. Reuse discovery/templates/components; optional panels group physical gauges by UUID, show unavailable coverage and never sum ratios or parent/MIG duplicates. Keep English/French copy in shared catalogs as a contiguous `gpu_*` feature block.

### Acceptance requires honest fixtures and authorized hardware

Synthetic backend replay must remain labelled synthetic. Existing contract vectors and fake-entity injections are **not hardware recordings**. The [trimmed A10 capture](../tests/fixtures/gpu/a10/README.md) supplies owner-recorded CLI field values and capabilities. It does not contain native C tags/statuses/timestamps or process observations; those test wrappers remain explicitly synthetic.

### Recorded A10 load evidence

On 2026-11-16 the owner captured one Lambda on-demand NVIDIA A10 on Ubuntu 22.04, driver **580.105.08**, CUDA **13.0**, DCGM **4.8.0**, with `RmProfilingAdminOnly=1`. Installed packages included `datacenter-gpu-manager-4-cuda13`, `datacenter-gpu-manager-4-proprietary` and `datacenter-gpu-manager-4-proprietary-cuda13`. The profiling module is supplied by the proprietary package; the owner observed module-not-loaded errors without it.

The recorded `dcgmi profile -l` offers SM activity/occupancy, Tensor and FP32 in A.1, FP16 in A.3, DRAM, engine activity and PCIe/NVLink fields. **FP64 field 1006 is not offered on this A10.** Retain its catalogue definition for devices that support it, but do not watch it or emit zero here: report unsupported status. Offered fields are not proof of a value: NVLink was listed but not sampled in this capture and remains unavailable in replay.

All four `dcgmproftester13` loads (1004, 1007, 1008, 1002) reported `PASSED`. Representative recorded one-second samples show:

| Load           | NVML-backed GPU utilization (203) | SM activity | SM occupancy | Tensor | FP32  | FP16  |
| -------------- | --------------------------------- | ----------- | ------------ | ------ | ----- | ----- |
| Tensor         | 100%                              | 0.986       | 0.164        | 0.927  | 0.000 | 0.002 |
| FP32           | 100%                              | 0.995       | 0.994        | 0.000  | 0.568 | 0.000 |
| FP16           | 100%                              | 0.995       | 0.994        | 0.000  | 0.000 | 0.878 |
| SM ramp, early | 100%                              | 0.052       | 0.001        | 0.000  | 0.000 | 0.000 |
| SM ramp, late  | 100%                              | 0.940       | 0.020        | 0.000  | 0.000 | 0.000 |

Conventional NVML GPU utilization reached **100% in every load phase**, while per-pipe fields separated the workloads and SM activity/occupancy exposed the ramp. Not every busy sample was exactly 100%; some were 98–99%. Supported zeros in the table are actual displayed readings, unlike the absent FP64 field. No general overhead or throughput-efficiency bound follows from these samples.

Fixtures preserve selected original decimal values, source line references and all offered field IDs, with no machine identifiers. Replay exercises the decoder, capability-aware watch/session path through a synthetic C shim, and collector units/status/OTLP mapping. This does not claim the Rust collector or binding ran on that A10/DCGM 4.8.0 host, nor validate NVML process attribution, MIG/NVLink hardware, ECC/XID reads or end-to-end execution analytics. The recorded instance is terminated; do not try to reach it or start replacement resources.

### Collector-to-ClickHouse validation on L4

On 2026-11-16 the owner ran the prepared harness on one Google Cloud NVIDIA L4 with Ubuntu 22.04, driver **580.178.04**, CUDA **13.0** and DCGM **4.8.0**, including the proprietary profiling packages. The exact source snapshot was built natively with Rust 1.99.0. The collector enrolled into a dedicated project and exported through private SSH reverse tunnels to the existing ingestion API, Kafka, normalizer and ClickHouse stack. The owner deleted the VM after the run.

The mandatory ClickHouse verifier passed. Recorded peaks were approximately **0.951 Tensor**, **0.568 FP32** and **0.865 FP16** under the corresponding labelled generator loads. GPU UUID, utilization and framebuffer memory were present. Actual NVML process memory and utilization points were covered by the labelled execution's nonretracted process membership intervals; device pipe readings remained node context, not process-attributed pipe usage.

`dcgmi profile -l` did not offer **1006 (FP64), 1011 or 1012 (NVLink)**. ClickHouse contained no scalar points for these fields, including zero, and retained explicit unsupported read statuses. Other offered profiling fields had either readings or explicit unavailable coverage. This result establishes this L4 configuration, not universal L4/T4 field support. The A10 recordings remain separate offline fixtures.

Authenticated browser capture was skipped; the owner checks the web UI separately. Activity distinguishes pipe series through its existing point-attribute column mechanism: select `attributes["gpu.pipe"]` in Columns, as for `cpu.mode` or disk dimensions. New GPU lab projects select that column as their project default; no GPU-specific table or row renderer is needed.

The collector log retained **32 metric export retry warnings** (31 at attempt 0, one at attempt 1) and **34 participant export retry warnings**. The default ingestion limit is one shared in-flight request; metrics, participants and health checks compete for it across connections. A direct loopback probe without SSH reproduced gRPC `Unavailable` with `Ingestion is at capacity` while another connection held that slot. The saved collector warnings contain only the status code, not the status message, so the historical failures cannot be conclusively separated from transport failures. Admission contention is consistent with the observed short retries. Keep the bounded unchanged-payload retry behavior and defaults: this run shows eventual delivery, not measured capacity evidence justifying a larger admission limit. No shared checkpoints or data were reset.

MIG, multi-GPU behavior, NVLink hardware, overhead and other driver/GPU combinations remain separate hardware gates.

### Real DCGM without a GPU

DCGM **4.7.1** successfully started in both embedded mode and foreground standalone mode in the reused ARM64 Linux build container. The environment had no `/dev/nvidiactl`, `/proc/driver/nvidia/version` or loadable `libnvidia-ml.so.1`. The standalone probe used an owned Unix socket/PID/log under ignored test state and was terminated after three seconds; no shared host engine or infrastructure was reset.

The experiment used only the NVIDIA repository's `libdcgm` (2,156,368 bytes), `nv-hostengine` (453,116 bytes) and `dcgmi` (1,183,862 bytes) packages for version `1:4.7.1-2`. They were checksum-verified against the [official ARM64 package index](https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/sbsa/Packages.gz) and extracted locally, not installed; no driver, NVML or CUDA runtime was installed. This is about 3.8 MB of downloads, not a full GPU software stack.

NVIDIA's [host-engine initialization](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/src/DcgmHostEngineHandler.cpp#L1896-L1907) explicitly continues with `m_nvmlLoaded=false` when NVML initialization fails. The real library also accepted `dcgmCreateFakeEntities` and `dcgmInjectFieldValue`, then returned injected SM/pipe ratios, measured zero and a finite unavailable sentinel through the production batch reader/decoder.

An opt-in, ignored Rust test reproduces that path in an isolated, owned embedded MANUAL engine:

```sh
cargo test --locked -p recount-nvidia-dcgm \
  ffi::fake::real_dcgm_fake_entities -- --ignored --exact --nocapture
```

Provide a target-compatible DCGM 4 runtime through the system loader first. The test refuses driver/NVML-equipped environments and never connects to an existing daemon. Its [test/internal APIs](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmlib/dcgm_test_apis.h) are explicitly unofficial NVIDIA interfaces; their pinned declarations compile only into tests. Production exposes no fake-entity or arbitrary injection API.

This validates real DCGM cache handling and the binding ABI without hardware. It does **not** validate physical counters, the proprietary DCP module, permissions, multiplexing, MIG hardware or NVML process attribution. In particular, a core-only runtime can pass this test while T4/L4 profiling is still unavailable: verify the installed DCP/profiling module separately before the AWS hardware run.

| Gate                 | Required coverage                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional/no-GPU      | Baseline parity/no absence warnings; missing library versus zero devices, denied init, missing symbols, driver mismatch/loss/reconnect, bounded worker queues/backoff.                                            |
| Values/cache         | Finite blanks, valid zero, NVML sentinels, exact large integers, overflow/units, tuple correlation, malformed native output, first sample, repeated timestamps/source switches.                                   |
| Process/time         | Actual-read brackets; historical PID reuse, exit/races, namespace mismatch, bootstrap flush, clock uncertainty/steps, all shared-timestamp rows, bounded retries/unchanged cursor.                                |
| Multi-GPU/MIG        | Same CPU/GPU process ID, sparse slots/lifetime changes, parent-scope rejection, overlapping lists/shared GI memory, unsupported process utilization.                                                              |
| Admission/executions | Allowed/denied GPU grants, suppressed GPU emission with accepted CPU/process batch, renewal gating, explicit exclusions, foreign scope rejection, unchanged process hashes, fact semijoin without multiplication. |
| Repository           | Host-supported checks natively; Linux workspace tests/lints in reused Linux build container with named Cargo caches; reused backend and isolated namespaces, no infrastructure recreation/reset.                  |

Use established workspace tests and `just check-rust` in supported environments. Pure fixtures do not replace native replay/auth/browser gates.

The A10 recordings were supplied by the owner; no remote access or new hardware run was performed by the collector agent. Overhead benchmarks remain unavailable. The optional owner-written AWS lab provides one T4, SSM, 30-minute auto-shutdown and `smoke.sh`. Read its configuration for reference only; do not modify that worktree. The owner provisions resources: never run `tofu apply` or instance-start actions as part of this work. Before any further hardware validation, present the exact proposed commands and their purpose, then wait for authorization. T4 cannot validate MIG or NVLink.

Measure startup/discovery/query/scan latency, collector/host-engine CPU and RSS, cache retention, reconnect behavior and workload slowdown against CPU-only baseline on representative hardware; make no quantitative overhead promise from general vendor claims ([profiling constraints](https://docs.nvidia.com/datacenter/dcgm/latest/learn/modules/profiling.html), [retention](https://docs.nvidia.com/datacenter/dcgm/latest/learn/core-services/fields-and-watches.html)).

The selected process path exports current NVML process memory and supported, validated buffered SM/memory activity on the existing process resources. It exports no DCGM process/job lifetime summaries and enables no persistent accounting watches. Existing participant facts attribute those genuine process points to environment-labelled executions automatically; device pipe/SM profiling remains context, not process usage.

The process metrics are `recount.process.gpu.memory.used` (int64 `By`), `recount.process.gpu.utilization` (double ratio `1`) and `recount.process.gpu.memory.activity` (double ratio `1`), each with point dimension `gpu.uuid`. Memory reads are bracketed by the existing verified CPU incarnation and a fresh post-query procfs check. Compute/graphics lists overlap and are never summed. MIG process lists use verified compute-instance handles rather than duplicating parent totals; conventional process utilization remains unsupported there.

Utilization cursors are per UUID. Flush bootstrap history, process every PID sharing a native timestamp, and advance only after a complete successful fetch. Accept a buffered sample only within a retained, unchanged incarnation window after two acquisition intervals of warm-up, with a plausible positive epoch timestamp no later than the validated collector clock. Clock discontinuity or collection-epoch changes clear attribution history. Ambiguous clock/domain/lifetime evidence remains unavailable, not retrospective PID attribution.

The templates rework is already on this base, so no GPU dashboard template, GPU page or component is added. Web presentation changes are limited to friendly EN/FR metric names and shared UCUM formatting. The separately approved enrollment default/migration is backend authorization, not GPU UI.

Missing per-process/job pipe counters and unvalidated historical process attribution remain explicit coverage limits, not zeros or inferred measurements.

## Hardware validation

Check the full collector-to-storage path on a temporary Google Cloud GPU with the
[demo collectors](../infra/demo/README.md):

```sh
just demo up --project "GPU demo" --gpu --load --ttl 2h
```

It starts a Spot L4 (falling back to a T4), installs DCGM without replacing the
image's driver, installs the collector from the latest attested release and
runs labelled tensor, FP16 and FP32 load. Check the project's GPU metrics and
executions in the app, or `telemetry.metric_points` in ClickHouse. Profiling
expectations come from `dcgmi profile -l` on that host, not the GPU model.

To record the capability catalogue and raw readings of a new GPU model, run the
standalone probes on such a host with the source checkout and Rust 1.99
available:

```sh
nvidia-smi
dcgmi discovery -l
dcgmi profile --list --entity-id gpu:0
cargo build --locked -p recount-nvidia-dcgm --example snapshot
cargo build --locked -p recount-collector --example gpu_snapshot
cargo run --locked -p recount-nvidia-dcgm --example snapshot \
  | tee dcgm-idle.log
```

These commands establish the hardware/runtime capability catalogue and capture native-time idle readings. If the toolchain or profiling module is missing, stop rather than install packages implicitly.

After identifying an already-installed CUDA-compatible `dcgmproftester12` or `dcgmproftester13`, set `DCGM_PROFTESTER` to that executable. Set `SUPPORTED_FIELDS` from the actual runtime catalogue and supported generator tests: the recorded A10 can use `1002 1003 1004 1007 1008`, not 1006. Include FP64 only when the target actually offers it. Capture active readings separately:

```sh
for field in $SUPPORTED_FIELDS; do
  "$DCGM_PROFTESTER" --no-dcgm-validation -i 0 -t "$field" -d 10 \
    >"dcgm-load-$field.log" 2>&1 &
  load_pid=$!
  cargo run --locked -p recount-nvidia-dcgm --example snapshot \
    | tee "dcgm-snapshot-$field.log"
  wait "$load_pid"
done
```

Repeat a supported ten-second generator workload with `RECOUNT_EXECUTION=gpu:validation` in its environment while running the collector-level probe:

```sh
RECOUNT_EXECUTION=gpu:validation "$DCGM_PROFTESTER" \
  --no-dcgm-validation -i 0 -t 1004 -d 10 >dcgm-process-load.log 2>&1 &
load_pid=$!
cargo run --locked -p recount-collector --example gpu_snapshot \
  | tee collector-gpu-process.jsonl
wait "$load_pid"
```

The collector probe asserts initial-host PID visibility and must run on the host, not an unverified container namespace. It samples for fifteen seconds without enrollment, queues or uploads. Its JSONL preserves scalar type and exact integer/time text, process PID/start ticks/incarnation, GPU dimensions and read statuses. Check that GPU process identities match their CPU identities and that supported process samples appear only after verified lifetime/clock evidence. This probe does not publish participant facts or prove the whole collector-to-browser execution path; the existing participant/admission fixtures cover that separate join boundary.

This creates bounded test workloads, not AWS resources. It checks field support, watch warm-up, valid ratios, unavailable values and load response without changing global profiler policy. Logs from the safe snapshot API contain validated native scalar types, error categories and timestamps; they are not raw C memory dumps. Record GPU model/UUID, driver/DCGM versions and test commands alongside them, then replay the recordings through the adapter tests. Do not require every pipe to be supported or interpret multiplexed zeros as proof of idleness. T4 cannot validate MIG or NVLink, and this test does not close the process-attribution acceptance check.
