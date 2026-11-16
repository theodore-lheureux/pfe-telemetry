# Recorded A10 device telemetry

The owner recorded one NVIDIA A10 on a Lambda on-demand instance on 2026-11-16. The host ran Ubuntu 22.04, driver **580.105.08**, CUDA driver API **13.0** and **DCGM 4.8.0**. The instance is terminated. These fixtures need no network access or GPU.

The owner reported `RmProfilingAdminOnly=1` and installed:

- `datacenter-gpu-manager-4-cuda13`
- `datacenter-gpu-manager-4-proprietary`
- `datacenter-gpu-manager-4-proprietary-cuda13`

The profiling module comes from the proprietary package. The owner observed `dcgmi profile` reporting the module as not loaded without it. A core-only DCGM runtime passing fake-entity tests does not establish DCP availability.

## Trimming and provenance

- `profile-groups.txt` preserves every offered field and group/subgroup from the original `dcgmi profile -l`, with table borders/tags removed. **1006 / FP64 is absent**, not zero. Offered NVLink fields 1011/1012 were not included in `dmon.txt`; their values are unknown.
- `dmon.txt` retains selected one-second `dcgmi dmon` rows. Decimal tokens are unchanged. Repeated headers, the ordinal `GPU 0` label and padding were removed. Added `source_line` values refer to the original file's one-based lines, including its headers.
- Phase labels follow the original `phases.txt` sequence and the corresponding `proftester-<field>.log` results. Each log reports `PASSED`: Tensor 1004 at line 43, FP32 1007 at line 43, FP16 1008 at line 43 and SM activity 1002 at line 44. Samples are selected within the characteristic stable/ramping portions, not assigned native phase-boundary timestamps.
- `version.txt` and the product/driver/CUDA fields of `nvidia-smi-q.txt` supply the version/model metadata above. Full diagnostics, serial numbers, addresses, hostnames, instance identifiers, GPU UUID and workload process identifiers are intentionally not copied.

The original recordings were supplied under the local capture directory `gpu-a10-20261116`. The fixture has no dependency on that directory, an absolute contributor path or the terminated host.

## Interpretation and replay limits

Conventional NVML-backed GPU utilization (DCGM field 203) reaches **100% in every load phase**, while pipe metrics separate Tensor, FP32 and FP16 loads. The SM load changes activity/occupancy despite similarly saturated conventional utilization. Not every busy row is exactly 100%; the original recording also has 98–99% samples.

Recorded supported zeros are real observations: for example Tensor is `0.000` during the FP32 load. Do not replace the unsupported FP64 field with such a zero. Memory activity (204) can also be zero during a compute-heavy load while framebuffer allocation (252) remains nonzero.

Ratio fields 1001–1008 are dimensionless, 1009/1010 are `By/s`, 203/204 are integer percent, 252 is MiB, 155 is watts, 150 is Celsius and 100/101 are MHz. Tests retain these native meanings and check collector conversion to ratios, bytes and hertz.

This CLI recording contains no native per-field timestamps, raw C status/type tags or process samples. Test times, native ABI wrappers and the canonical GPU UUID used by the adapter tests are **synthetic**, not hardware recordings. The synthetic C shim replays the A10 capability list and one recorded Tensor row through the real binding/session code; it is not the DCGM 4.8.0 library.

These recordings validate the vendor field catalogue and load-dependent device values. They do not prove the collector itself ran on A10, its native binding against DCGM 4.8.0, NVML process attribution, MIG/NVLink hardware behavior, ECC/XID reads, overhead or the collector-to-browser pipeline.
