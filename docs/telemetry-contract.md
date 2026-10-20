# Telemetry collection and ingestion contract

The `external/1.0` profile carries Linux node and process measurements as OTLP metrics. Its collection, ingestion and storage rules are implementation requirements. See the [ingestion server](../apps/server/README.md) for currently implemented behavior.

Draft version 1.0.

## Wire format and profiles

Use OTLP/gRPC `opentelemetry.proto.collector.metrics.v1.MetricsService/Export` with the standard `ExportMetricsServiceRequest` and `ExportMetricsServiceResponse`. Support uncompressed and gzip requests, with a 4 MiB decoded receiver limit and a 1 MiB collector limit before compression. [Service definition](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/metrics/v1/metrics_service.proto), [receiver settings](../apps/server/README.md)

Request metadata `pfe-collection-profile: external/1.0` selects the external collection profile. Requests without it use standard OTLP compatibility input. Ingestion must accept standard OTLP metrics and traces within source permissions and admission limits. Preserve their native semantics and mark absent context as unknown. Compatibility input does not guarantee full process identity or duplicate-safe client retries.

Authentication must establish trusted `project_id` and `source_id`, permitted hosts and signal types. Payload attributes cannot change these permissions. Require TLS outside the isolated test environment. Execution registration and human ownership belong to the [application API](architecture.md).

## Resource fields

External attributes belong to `ResourceMetrics.resource`. Strings are non-empty UTF-8, at most 128 bytes; IDs are case-sensitive. UUIDs are lowercase hyphenated strings. Integer attributes use `AnyValue.int_value`; decimal uint64 strings use `string_value`.

Treat UUIDs as opaque identifiers. Their embedded time must not replace explicit measurement, batch-creation or receipt timestamps, or establish event order across nodes. UUIDv4 is sufficient for collection epoch and counter segment IDs, which do not require ordering. [UUID format and timestamp considerations](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)

| Required attribute           | Type           | Scope and meaning                                                                           |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `host.id`                    | string         | All: enrolled unique machine identity. Cloned machine IDs require separate enrollment IDs.  |
| `pfe.host.boot_id`           | string         | All: changes after host reboot, unchanged by collector restart.                             |
| `pfe.collection.scope`       | string enum    | All: `node`, `process`, `collector`.                                                        |
| `pfe.collection.source`      | string         | All: acquisition implementation.                                                            |
| `pfe.collection.epoch_id`    | UUID string    | All: new after collector restart or sampling-clock discontinuity.                           |
| `os.type`                    | string         | All: `linux`.                                                                               |
| `pfe.collection.interval_ns` | positive int64 | All: intended sampling period.                                                              |
| `process.pid`                | positive int64 | Process: PID in the declared namespace.                                                     |
| `pfe.process.namespace_id`   | string         | Process: stable namespace identifier within the boot; initial VMs use `host`.               |
| `pfe.process.incarnation_id` | string         | Process: token stable for its lifetime, distinguishing PID reuse across collector restarts. |
| `pfe.collection.visibility`  | string enum    | Collector: `host` enumerates initial host PIDs; `restricted` enumerates a narrower set.     |

The process key is `(authenticated project, host.id, boot_id, namespace_id, process.pid, incarnation_id)`. On Linux, `start-ticks:<decimal>` is valid when the collector reads and rechecks both the PID and start ticks before emission. Rounded creation times or UUIDs regenerated on discovery cannot satisfy this identity. Discard readings when the process incarnation cannot be verified.

Every external `ScopeMetrics.scope` requires non-empty `name` and `version` strings, at most 128 bytes, identifying the collection or normalization component. An adapter's mapping description must retain source metric names, dimensions and conversions. Keep weaker compatibility identities separate from fully identified process histories.

| Optional attribute                                 | Type and placement                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `host.name`                                        | Resource string, any scope; display only.                                                               |
| `process.parent_pid`                               | Process resource non-negative int64; same namespace.                                                    |
| `pfe.process.start_time_unix_nano`                 | Process resource decimal uint64 string; requires positive int64 `pfe.process.start_time_resolution_ns`. |
| `pfe.process.start_time_ticks`                     | Process resource decimal uint64 string; requires positive int64 `pfe.linux.clock_ticks_per_second`.     |
| `pfe.collection.capabilities`                      | Collector resource string array; absence means none declared.                                           |
| `pfe.execution.id`, `pfe.execution.association_id` | Process point strings; incomplete claims remain unassociated.                                           |

Resource and point attributes identify OTLP metric streams. Report changing clock status and uncertainty as the diagnostic gauge values below, never as resource or point attributes. Keep the intended sampling period constant within an epoch; changing it starts a new epoch. [Metric stream identity](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#opentelemetry-protocol-data-model)

Application-generated execution and association IDs use UUIDv7. Resolve execution claims against association records in the same project. These records contain the full process key, validity interval, evidence and authorized creator. If a reference is missing or inconsistent, leave the measurements visibly unassociated and accept them if otherwise valid. Parent PID alone cannot prove execution membership. Keep node measurements at node scope. Do not assign a shared worker's entire CPU usage or RSS to each job.

The default metadata allowlist comprises these fields and the dimensions below. Exclude arguments, environment variables, executable paths, owners, application files, memory contents and free-form read errors. Application OTLP attributes follow their source policy.

## Measurements

Each cycle must attempt the baseline categories for the node and visible processes. Verify process identity before emission, then emit available points and coverage diagnostics. Successful discovery with no devices is valid. Periodic scans can miss short-lived processes.

| Metric                      | Scope   | Data / value / unit    | Point dimensions and meaning                                                                                                                        |
| --------------------------- | ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pfe.node.cpu.time`         | Node    | Counter / double / `s` | `cpu.mode`: supported `user`, `nice`, `system`, `idle`, `interrupt`, `softirq`, `steal`; aggregate logical CPUs. Guest time stays within user/nice. |
| `pfe.node.memory.total`     | Node    | Gauge / int64 / `By`   | OS usable physical RAM.                                                                                                                             |
| `pfe.node.memory.available` | Node    | Gauge / int64 / `By`   | OS estimate allocatable without swapping.                                                                                                           |
| `system.disk.io`            | Node    | Counter / int64 / `By` | `system.device`: boot-local address, e.g. `block:8:0`; `disk.io.direction`: `read`, `write`; block-accounted bytes.                                 |
| `process.cpu.time`          | Process | Counter / double / `s` | `cpu.mode`: `user`, `system`; process and threads, excluding child-process accounting.                                                              |
| `pfe.process.memory.rss`    | Process | Gauge / int64 / `By`   | Resident memory including shared pages.                                                                                                             |
| `process.disk.io`           | Process | Counter / int64 / `By` | `disk.io.direction`: `read`, `write`; storage-accounted bytes.                                                                                      |

Dimensions are strings. Counters are cumulative monotonic OTLP Sums (`aggregation_temporality = 2`, `is_monotonic = true`). Custom `pfe.*` metrics specify aggregate CPU and memory gauges; conventional counter names retain their definitions. [System conventions](https://opentelemetry.io/docs/specs/semconv/system/system-metrics/), [process conventions](https://opentelemetry.io/docs/specs/semconv/system/process-metrics/)

Values must be finite and non-negative; byte counts must fit signed int64. Report overflow instead of wrapping or rounding values. Keep per-core CPU, private memory and logical I/O separate. Do not blindly sum overlapping device and partition I/O or RSS that includes shared pages. Linux iowait can decrease and is excluded from monotonic CPU counters.

## Time and continuity

`NumberDataPoint.time_unix_nano` records when the read completed, as a non-zero uint64 Unix timestamp in nanoseconds. Gauges use `start_time_unix_nano = 0`. Counters use a stable origin timestamp, or zero when that origin is unknown. A device created after boot cannot use boot time as its origin. Timestamp precision follows source resolution, not encoding. [Metric fields](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto)

Baseline counter points require `pfe.counter.segment_id` as a UUID string. Assign a new segment after a counter reset, missed or failed read, known local point loss, lost continuity or collector restart. Device disappearance or reappearance also starts a new segment.

Calculate rates only between successive points with the same resource key, source, scope version, dimensions, epoch and segment. Time must increase and the counter value must not decrease. Known downstream loss invalidates the interval.

`rate = (value2 - value1) / ((time2 - time1) / 1e9)`

CPU rate can exceed one. Calculating a percentage relative to allocated resources requires the actual allocation. Do not calculate counter rates from gauges. Preserve late points with their source time, server receipt time and clock diagnostics. A detected clock step ends the current cycle and starts a new epoch before further reads.

Emit `pfe.clock.status` and any known `pfe.clock.uncertainty` once per completed cycle, with the same timestamp as `pfe.collection.scan.duration`. Match them to readings in that scan window using authenticated project/source, host, boot, collection source, epoch and instrumentation scope. A synchronized status and uncertainty bound must cover the entire window. Missing, conflicting or insufficient diagnostics leave clock quality unknown; do not carry an older bound into later cycles. Retain these diagnostics through batch splitting and storage so late arrivals can be matched by source time rather than receipt order.

An unknown clock status can coexist with a coarse estimate adequate for submission-age admission, but supplies no measured synchronization bound across nodes. Compatibility delta sums retain their original intervals and types; conversion requires a documented mapping.

## Missing readings

Omit unavailable values. For each attempted category in each cycle, emit `pfe.collection.read.status` on the node or identified process, with dimension `pfe.metric.name`. Codes: `0` read, `1` unsupported, `2` permission denied, `3` disappeared, `4` read failed, `5` out of range, `6` temporarily unavailable.

For partial reads, retain the readable points and report the failure status. An unchanged counter has a measured delta of zero. Missing data is not zero.

| Diagnostic                            | Scope        | Data / value / unit         | Dimensions or meaning                                                                     |
| ------------------------------------- | ------------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| `pfe.collection.read.status`          | Node/process | Gauge / int64 / `1`         | Codes above.                                                                              |
| `pfe.collection.discovery.status`     | Collector    | Gauge / int64 / `1`         | Same codes.                                                                               |
| `pfe.collection.discovered.processes` | Collector    | Gauge / int64 / `{process}` | Visible entries this cycle.                                                               |
| `pfe.collection.discarded.processes`  | Collector    | Gauge / int64 / `{process}` | `reason`: `identity_unverified`, `disappeared`.                                           |
| `pfe.collection.scan.duration`        | Collector    | Gauge / double / `s`        | Monotonic duration at completion; scan window = completion minus duration.                |
| `pfe.clock.status`                    | Collector    | Gauge / int64 / `1`         | `0` unknown, `1` synchronized, `2` unsynchronized; applies to the completed scan window.  |
| `pfe.clock.uncertainty`               | Collector    | Gauge / int64 / `ns`        | Non-negative bound on the absolute source clock error for that window; omit when unknown. |
| `pfe.collection.dropped.points`       | Collector    | Counter / int64 / `{point}` | Since epoch; `reason`: `buffer_full`, `buffer_expired`, `permanent_rejection`.            |

Each read has its own timestamp; the scan is not an atomic snapshot. Host visibility does not imply that all fields are readable. Absent cycles expose disconnection. Points discarded locally after an uncertain acknowledgement may already exist in backend storage. The discard diagnostic alone must not create gaps where records are present.

## Delivery

External requests contain one value per metadata key:

| ASCII gRPC metadata           | Format                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `pfe-collection-profile`      | `external/1.0`                                                                 |
| `pfe-batch-id`                | Lowercase UUIDv7, assigned once per logical batch and retained across retries. |
| `pfe-batch-created-unix-nano` | Decimal uint64 creation timestamp.                                             |

Split batches before assigning IDs. Durably enqueue each payload and its metadata locally before sending. Retries must preserve the body, array order, values, timestamps and metadata. Never repackage attempted observations under new IDs. A point's identity combines the batch key with its positions in the resource, scope, metric and point arrays.

Validate the whole request before durable publication. Return gRPC `OK` with an empty standard response only after retaining the whole batch. Do not partially accept a batch. Authenticated empty requests may succeed without retention. Successful export confirms backend acceptance; analytical processing and queryability follow separately. Local enqueue confirms only that the pending upload can be recovered.

Remove pending records on confirmed success. A terminal rejection or expiry permits removal, provided the local discard and its reason are recorded. A timeout or lost acknowledgement leaves acceptance uncertain. Keep the batch pending for retry within its lifetime.

Retained envelopes include trusted project and source IDs, receipt time, server-generated UUIDv7 `record_id`, payload kind, profile and version, client identity and time, and the supported re-encoded OTLP payload. Retain the record ID unchanged through replay. See [serialization](serialization.md#retention-replay-and-compatibility).

Deduplicate external submissions by `(project_id, source_id, payload_kind, pfe-batch-id)`. Atomically commit measurements, deduplication state and aggregates before advancing consumer progress. Compatibility replay uses the trusted `record_id` instead of a client batch ID. Separate client resubmissions may therefore duplicate data.

The producer must keep batch content immutable. Ingestion is not required to detect every conflict caused by malicious batch ID reuse. Any detected conflict must not overwrite the first batch.

Enrollment publishes two durations in seconds: `maximum_submission_age` (`R`) and `allowed_clock_skew` (`S`). Both must be greater than zero. At receipt, reject batch creation times more than `S` ahead of the ingestion clock or more than `R + S` behind it. A creation time up to `S` in the future is admissible. These checks apply to batch creation, not individual measurement age. Never rewrite creation or measurement timestamps on retry or ingestion. These age guarantees assume a source clock within `S` of the ingestion clock.

Keep deduplication state until `created_at + R + S` has passed and the replay horizons of all retained records have expired. Extending replay requires extending deduplication retention or using a separate output generation. These bounded settings do not guarantee permanent deduplication or an outage window. See [recovery and retention](ingestion-and-reliability.md).

| Result                                                                                                     | Behavior                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Invalid fields/types/units/duplicate keys, non-finite values, batch creation more than `S` into the future | `INVALID_ARGUMENT`; whole request rejected.                                           |
| Unauthorized source/host                                                                                   | `UNAUTHENTICATED` or `PERMISSION_DENIED`; stop unchanged retries.                     |
| Unknown profile major / expired submission                                                                 | `FAILED_PRECONDITION`; stop unchanged retries.                                        |
| Oversized/permanently inadmissible request                                                                 | `RESOURCE_EXHAUSTED` without `RetryInfo`; stop unchanged retries.                     |
| Temporary sink/capacity failure                                                                            | `UNAVAILABLE`; retry unchanged with exponential backoff/jitter, honoring `RetryInfo`. |
| Transport loss / retryable OTLP status                                                                     | Retry unchanged within lifetime; acceptance may be uncertain.                         |

Follow the [OTLP failure table](https://opentelemetry.io/docs/specs/otlp/#failures) for other statuses. `RESOURCE_EXHAUSTED` is retryable only with recovery `RetryInfo`; received partial success is never retried. Keep credentials and telemetry bodies out of logs/responses.

## Compatibility

Accept additive `external/1.<minor>` extensions under source policy. Unknown optional fields do not satisfy baseline requirements. Changes to identity, required fields, units or aggregation meaning require a new metric name or profile major version. Reject unknown major versions without fallback.

Retain original profiles and historical mappings. Re-encoding supported Protobuf fields does not preserve unknown future fields or the original byte layout.

## Examples

JSON views of OTLP requests use decimal strings for 64-bit integers and integer enum values. The process RSS example is a batch fragment; other categories and statuses are reported in other fragments of the same cycle. [OTLP JSON mapping](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)

```json
{
  "resourceMetrics": [
    {
      "resource": {
        "attributes": [
          { "key": "host.id", "value": { "stringValue": "node-01" } },
          { "key": "pfe.host.boot_id", "value": { "stringValue": "boot-01" } },
          {
            "key": "pfe.collection.scope",
            "value": { "stringValue": "process" }
          },
          {
            "key": "pfe.collection.source",
            "value": { "stringValue": "rust-procfs" }
          },
          {
            "key": "pfe.collection.epoch_id",
            "value": { "stringValue": "bd2e9e7e-09b7-4e28-807d-1b71ab43de88" }
          },
          { "key": "os.type", "value": { "stringValue": "linux" } },
          {
            "key": "pfe.collection.interval_ns",
            "value": { "intValue": "1000000000" }
          },
          { "key": "process.pid", "value": { "intValue": "4821" } },
          {
            "key": "pfe.process.namespace_id",
            "value": { "stringValue": "host" }
          },
          {
            "key": "pfe.process.incarnation_id",
            "value": { "stringValue": "start-ticks:9500" }
          }
        ]
      },
      "scopeMetrics": [
        {
          "scope": { "name": "pfe.collector.procfs", "version": "0.1.0" },
          "metrics": [
            {
              "name": "pfe.process.memory.rss",
              "unit": "By",
              "gauge": {
                "dataPoints": [
                  { "timeUnixNano": "1780000100000000000", "asInt": "67108864" }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

For inaccessible I/O, add this metric to the same process's `scopeMetrics[0].metrics` and omit its `process.disk.io` value. Other readable values remain; no execution association is required.

```json
{
  "name": "pfe.collection.read.status",
  "unit": "1",
  "gauge": {
    "dataPoints": [
      {
        "timeUnixNano": "1780000100000000000",
        "asInt": "2",
        "attributes": [
          {
            "key": "pfe.metric.name",
            "value": { "stringValue": "process.disk.io" }
          }
        ]
      }
    ]
  }
}
```
