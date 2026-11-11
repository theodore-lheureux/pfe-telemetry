# Telemetry semantic model

Insights, dashboards, execution summaries, Activity filters and custom queries all ask the same kinds of questions about stored metric points. This model gives them one vocabulary and one typed query contract, compiled to ClickHouse SQL by a single authorized runner. Each feature describes _what_ to compute; the runner owns _how_, including project scoping, limits and the calculation rules for each metric kind.

Status: accepted design for [PFE-74](https://linear.app/pfe-telemetry/issue/PFE-74); implementation is in progress.

## Decisions

| Question                          | Proposal                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| What features query against       | One logical `points` table with named fields, not `metric_points` columns                                                                  |
| How the builder describes a query | A typed query object, validated on the server, never SQL assembled in the browser                                                          |
| How custom queries fit            | Later, a small SQL subset over the same logical table, resolved to the same plan ([PFE-79](https://linear.app/pfe-telemetry/issue/PFE-79)) |
| How calculations stay correct     | Each metric kind declares the calculations it allows; the runner rejects the rest                                                          |
| How series are combined           | Two stages: per series over time, then across series by group                                                                              |
| Where tenancy comes from          | The server adds the project; no query can name or remove it                                                                                |
| How executions fit                | An `execution` field on process points, so execution views are ordinary queries                                                            |
| Where discovery runs              | ClickHouse materialized views over inserted points, feeding small definition tables                                                        |

## Logical table

`points` presents one row per stored metric point, with duplicates removed as the current reader does. Fields have stable names, types and units, independent of physical columns:

| Field                                                    | Type                 | Source                                                   |
| -------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `time`                                                   | timestamp (ns)       | `time_unix_nano`                                         |
| `node`                                                   | node reference       | `source_id`, resolved to the collector node for display  |
| `resource.id`, `resource.kind`                           | string, enum         | `resource_id`, `resource_kind`                           |
| `host`                                                   | string               | `host_id`                                                |
| `metric.name`, `metric.kind`, `metric.unit`              | string, enum, string | `metric_name`, `metric_kind`, `unit`                     |
| `metric.temporality`, `metric.monotonic`                 | enum, boolean        | `temporality`, `monotonic`                               |
| `value`                                                  | number               | `int_value` or `double_value`, keeping integer precision |
| `count`, `sum`, `min`, `max`                             | number               | Histogram and summary fields                             |
| `resource.attributes["key"]`                             | typed value          | `resource_attributes`, matched by path                   |
| `scope.name`, `scope.version`, `scope.attributes["key"]` | string, typed value  | Instrumentation scope fields                             |
| `attributes["key"]`                                      | typed value          | `point_attributes`                                       |
| `execution`                                              | execution reference  | Resource attribute `recount.execution.id` (planned)      |

Attribute fields keep their observed types: comparing `attributes["cpu.mode"] = "user"` only matches string values. A key with conflicting types is reported by discovery rather than coerced.

Continuity is internal. The runner uses `stream_id` segments, boot IDs, epoch IDs and counter segments to compute rates and increases correctly; queries never group by them.

## Series and calculations

A **series** is one logical stream: the same project, node, resource, metric and full attribute set. Every query aggregates in two stages:

1. **Per series over time:** within each time bucket, reduce one series to one value using the metric's calculation.
2. **Across series:** combine series that share the requested group (for example by node) with a combining function.

Each metric kind allows specific calculations. The runner rejects any other combination with a clear validation error.

| Metric kind                         | Per-series calculations                          | Combining across series     |
| ----------------------------------- | ------------------------------------------------ | --------------------------- |
| Gauge                               | `last`, `avg`, `min`, `max`                      | `sum`, `avg`, `min`, `max`  |
| Monotonic cumulative sum (counters) | `rate` (per second), `increase`                  | `sum`                       |
| Delta sum                           | `sum`, `rate`                                    | `sum`                       |
| Non-monotonic sum                   | Treated as a gauge                               | As gauge                    |
| Histogram                           | `count` and `sum` as counters; percentiles later | `sum`; merged buckets later |
| Exponential histogram, summary      | Not aggregated in the first version              | Not combined                |

Counter rules: `increase` sums positive differences between consecutive points within a continuity segment, so resets and restarts never produce negative values or false spikes. `rate` divides that increase by elapsed time. A bucket without enough points for a difference is empty, not zero.

Totals for a whole range, such as an execution's CPU time or bytes written, are the same calculations with one bucket covering the range.

## Query object

The visual builder, saved analyses and execution pages all produce this object. The server validates it against the logical table and discovery catalog before compiling it:

```json
{
  "shape": "timeseries",
  "range": { "from": "2026-11-11T10:00:00Z", "to": "2026-11-11T11:00:00Z" },
  "interval": "1m",
  "measures": [
    {
      "name": "cpu",
      "metric": "recount.node.cpu.time",
      "calculation": "rate",
      "combine": "sum",
      "filters": [
        {
          "field": "attributes[\"cpu.mode\"]",
          "op": "in",
          "values": ["user", "system"]
        }
      ]
    }
  ],
  "filters": [{ "field": "node", "op": "in", "values": ["<node id>"] }],
  "groupBy": ["node"],
  "limit": { "series": 50 }
}
```

- `shape` is `timeseries` (one value per bucket per group) or `table` (one value per group over the whole range).
- `range` is absolute or relative (`"last": "1h"`); the server resolves relative ranges once per run.
- Filters combine with AND; `in` with several values is OR. Operators: `eq`, `neq`, `in`, `not_in`, `exists`, `not_exists`, and numeric comparisons on numeric fields.
- Measure filters apply to one measure; top-level filters apply to all.
- `groupBy` accepts any field except `time` and `value`.

## Results

Every runner result, whatever produced the query, has the same shape: typed columns with units, then rows or series. Calculated values are 64-bit floating point, so integers above 2^53 lose precision once aggregated; exact stored values remain available through Activity. Results also report the resolved range, bucket size and the series limit if it applied. Capacity, timeout and storage failures are errors, never silently truncated results.

## Authorization and limits

The runner resolves the project from the authorized request and adds it to every query structurally, in the compiled plan, not by editing SQL text. It keeps the current reader's protections: a SELECT-only ClickHouse account, per-process concurrency, row, byte, memory and time limits, and bounded bucket counts. Execution, saved-analysis and dashboard identifiers are always resolved with organization and project predicates first.

## Discovery

Selectors and query validation need to know which metrics and attributes exist in a project. ClickHouse materialized views on `metric_points` maintain two small tables as points arrive:

- **Metric definitions:** project, metric name, kind, unit, temporality, monotonicity, description, first and last seen.
- **Attribute definitions:** project, metric name, attribute scope (resource, scope or point), key and observed value kind.

Both aggregate continuously, so discovery adds no write path to ingestion and no PostgreSQL writes. Value suggestions are separate bounded queries over recent points, not stored dictionaries. Discovery describes what has arrived; it never acts as an allowlist that rejects new metrics. Adding these tables is a ClickHouse schema change, applied with the existing prepare-and-recreate workflow for disposable data.

## Executions

Process points belonging to an execution carry the resource attribute `recount.execution.id`, set by the collector (see the planned execution model). Execution features are then ordinary queries:

- **Usage:** `filters: execution = X`, grouped by node or combined.
- **Node and cluster context:** the same measures without the execution filter, restricted to the execution's nodes or the whole project.
- **Totals and comparison:** `table` queries over each execution's range.

## Alternatives considered

| Option                                      | Why not chosen                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| One hand-written reader per feature (today) | Each feature reinvents calculations, limits and authorization; results diverge                       |
| Expose ClickHouse SQL directly              | No tenant isolation, no calculation rules, and physical columns become a public contract             |
| Adopt PromQL                                | Strong for counters, but foreign to the builder, weak for attribute-rich OTLP data and table results |
| Build our own query language first          | High cost before the builder proves what is needed; a SQL subset can come later on the same plan     |

## Consequences

- Features stop querying `metric_points` directly; the execution chart reader is replaced by the runner.
- New calculations are added once, in the runner, with tests for their semantics.
- Physical schema changes no longer break features, as long as the logical table keeps its fields.

## Settled choices

- Discovery uses ClickHouse materialized views, not normalizer extraction into PostgreSQL.
- The first vertical slice covers gauges and monotonic counters, `timeseries` and `table` shapes, and grouping by node and attributes.
- Buckets align to the interval, not to the range start.
- Units are converted for display in the UI; the runner returns stored units.
