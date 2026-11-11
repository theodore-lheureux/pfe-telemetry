import type { AnalyticsQuery, Filter, MetricBehavior } from "./contracts";
import { INTERVALS, MAX_SERIES, type Measure } from "./contracts";
import { type ParsedField, parseField } from "./validation";

export interface CompiledMeasure {
	sql: string;
	params: Record<string, string | number | string[]>;
	groupColumns: string[];
}

export interface CompileScope {
	projectId: string;
	from: Date;
	to: Date;
	/** Stored kind of the measured metric, so mixed-kind names are never combined. */
	kind: number;
	behavior: MetricBehavior;
}

const NS_PER_MS = 1_000_000n;

// Series identity: everything that distinguishes a logical stream, except continuity
// markers, which the counter calculation handles through `stream_id` instead.
function canonical(column: string, excluded: string[]) {
	const nodes = excluded.length
		? `arrayFilter(a -> a.path NOT IN (${excluded.map((path) => `'${path}'`).join(",")}), ${column})`
		: column;
	return `arraySort(a -> a.1, arrayMap(a -> tuple(a.path, a.kind, a.string_value, a.int_value,
    if(isNull(a.double_value), NULL, reinterpretAsUInt64(assumeNotNull(a.double_value))),
    a.bool_value, a.bytes_value), ${nodes}))`;
}
const SERIES = `cityHash64(tuple(source_id, resource_id, resource_kind, host_id, device_id,
    scope_name, scope_version, metric_name, unit,
    ${canonical("resource_attributes", ["/recount.host.boot_id", "/recount.collection.epoch_id"])},
    ${canonical("scope_attributes", [])},
    ${canonical("point_attributes", ["/recount.counter.segment_id"])}))`;

// Missing or no-recorded values stay NULL and are skipped, never counted as zero.
const VALUE = `if(bitAnd(flags, 1) = 0,
    if(isNull(int_value), double_value, toFloat64(int_value)), NULL)`;

class Params {
	readonly values: Record<string, string | number | string[]> = {};
	private next = 0;
	constructor(private readonly prefix = "p") {}
	bind(value: string | number | string[], type: string) {
		const name = `${this.prefix}${this.next++}`;
		this.values[name] = value;
		return `{${name}:${type}}`;
	}
}

function fieldExpression(field: ParsedField, params: Params) {
	if (field.type === "core") {
		switch (field.name) {
			case "node":
				return "source_id";
			case "host":
				return "host_id";
			case "resource.id":
				return "resource_id";
			case "resource.kind":
				return "toString(resource_kind)";
			case "scope.name":
				return "scope_name";
		}
	}
	const column =
		field.scope === "resource" ? "resource_attributes" : "point_attributes";
	// Attribute paths are JSON-pointer style; top-level keys are `/key`.
	const node = `arrayFirst(a -> a.path = ${params.bind(`/${field.key}`, "String")}, ${column})`;
	return `multiIf(tupleElement(${node}, 'kind') = 2, tupleElement(${node}, 'string_value'),
    tupleElement(${node}, 'kind') = 3, toString(tupleElement(${node}, 'int_value')),
    tupleElement(${node}, 'kind') = 4, toString(tupleElement(${node}, 'double_value')),
    tupleElement(${node}, 'kind') = 5, if(tupleElement(${node}, 'bool_value'), 'true', 'false'),
    tupleElement(${node}, 'kind') = 6, base64Encode(tupleElement(${node}, 'bytes_value')),
    NULL)`;
}

function filterExpression(filter: Filter, params: Params) {
	const expression = fieldExpression(parseField(filter.field), params);
	switch (filter.op) {
		case "exists":
			return `(${expression}) IS NOT NULL`;
		case "not_exists":
			return `(${expression}) IS NULL`;
		case "eq":
		case "in":
			return `(${expression}) IN ${params.bind(filter.values ?? [], "Array(String)")}`;
		// A missing field is "not equal" to every value, matching filter UIs.
		case "neq":
		case "not_in":
			return `((${expression}) IS NULL OR (${expression}) NOT IN ${params.bind(filter.values ?? [], "Array(String)")})`;
	}
}

/** Filters as bound SQL conditions, for readers outside the measure compiler. */
export function compileFilters(filters: Filter[]) {
	const params = new Params("f");
	const conditions = filters.map((filter) => filterExpression(filter, params));
	return { conditions, params: params.values };
}

/** Field values as text expressions, for readers that show them as columns. */
export function compileFields(fields: string[]) {
	const params = new Params("c");
	const expressions = fields.map((field) =>
		fieldExpression(parseField(field), params),
	);
	return { expressions, params: params.values };
}

function perSeries(
	measure: Measure,
	behavior: MetricBehavior,
	groups: string,
	timeseries: boolean,
) {
	const keys = ["series", ...groups.split(", ").filter(Boolean), "bucket"].join(
		", ",
	);
	if (behavior === "gauge") {
		const aggregate = {
			last: "argMax(v, tuple(t, sample_id))",
			avg: "avg(v)",
			min: "min(v)",
			max: "max(v)",
		}[measure.calculation as "last" | "avg" | "min" | "max"];
		return `per_series AS (
  SELECT ${keys}, ${aggregate} AS value FROM base WHERE v IS NOT NULL GROUP BY ${keys}
)`;
	}
	// Rates divide by the time the range covers within each bucket, so the current,
	// still-filling bucket and a range starting mid-bucket are not understated.
	const covered = timeseries
		? "((least(bucket + {step:UInt64}, {to:UInt64}) - greatest(bucket, {from:UInt64})) / 1e9)"
		: "{seconds:Float64}";
	const scale = measure.calculation === "rate" ? ` / ${covered}` : "";
	if (behavior === "delta")
		return `per_series AS (
  SELECT ${keys}, sum(v)${scale} AS value FROM base WHERE v IS NOT NULL GROUP BY ${keys}
)`;
	// Cumulative counters: positive differences within one continuity segment. The first
	// point of a segment has no predecessor, so it contributes nothing.
	return `diffs AS (
  SELECT ${keys}, v - lagInFrame(v) OVER w AS d, row_number() OVER w AS n
  FROM base WHERE v IS NOT NULL
  WINDOW w AS (PARTITION BY stream ORDER BY t, sample_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
per_series AS (
  SELECT ${keys}, sum(greatest(d, 0))${scale} AS value FROM diffs WHERE n > 1 GROUP BY ${keys}
)`;
}

/** Compiles one measure of a validated query into a parameterized ClickHouse query. */
export function compileMeasure(
	query: AnalyticsQuery,
	measure: Measure,
	scope: CompileScope,
): CompiledMeasure {
	const params = new Params();
	const groupBy = query.groupBy ?? [];
	const groupColumns = groupBy.map((_, index) => `g${index}`);
	const groupSelect = groupBy
		.map(
			(field, index) =>
				`${fieldExpression(parseField(field), params)} AS ${groupColumns[index]}`,
		)
		.join(",\n    ");
	const filters = [...(query.filters ?? []), ...(measure.filters ?? [])].map(
		(filter) => filterExpression(filter, params),
	);
	const from = BigInt(scope.from.getTime()) * NS_PER_MS,
		to = BigInt(scope.to.getTime()) * NS_PER_MS;
	const bucketSeconds =
		query.shape === "timeseries" && query.interval
			? INTERVALS[query.interval]
			: (scope.to.getTime() - scope.from.getTime()) / 1000;
	// Timeseries buckets align to the interval; a table result is one bucket.
	const bucket =
		query.shape === "timeseries"
			? "intDiv(time_unix_nano, {step:UInt64}) * {step:UInt64}"
			: "toUInt64(0)";
	const groups = groupColumns.join(", ");
	const partition = groups ? `PARTITION BY ${groups}` : "";
	const sql = `
WITH base AS (
  SELECT ${SERIES} AS series, stream_id AS stream,
    ${groupSelect ? `${groupSelect},\n    ` : ""}time_unix_nano AS t, sample_id,
    ${bucket} AS bucket, ${VALUE} AS v
  FROM metric_points FINAL
  WHERE project_id = {project:String}
    AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
    AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}
    AND metric_name = {metric:String} AND CAST(metric_kind, 'Int16') = {kind:Int16}${filters.map((filter) => `\n    AND ${filter}`).join("")}
),
${perSeries(measure, scope.behavior, groups, query.shape === "timeseries")},
combined AS (
  SELECT ${groups ? `${groups}, ` : ""}bucket, ${measure.combine}(value) AS value
  FROM per_series GROUP BY ${groups ? `${groups}, ` : ""}bucket
),
ranked AS (
  SELECT *, dense_rank() OVER (ORDER BY weight DESC${groups ? `, ${groups}` : ""}) AS rank
  FROM (SELECT *, sum(abs(value)) OVER (${partition}) AS weight FROM combined)
)
SELECT ${groups ? `${groups}, ` : ""}toString(bucket) AS bucket, value, rank
FROM ranked WHERE rank <= {seriesLimit:UInt32}
ORDER BY rank, bucket`;
	return {
		sql,
		params: {
			...params.values,
			project: scope.projectId,
			metric: measure.metric,
			kind: scope.kind,
			from: from.toString(),
			to: to.toString(),
			step: (BigInt(Math.round(bucketSeconds)) * 1_000_000_000n).toString(),
			seconds: bucketSeconds,
			firstDay: Math.floor(scope.from.getTime() / 86_400_000),
			lastDay: Math.floor((scope.to.getTime() - 1) / 86_400_000),
			// One extra group reveals whether the limit cut any series.
			seriesLimit: MAX_SERIES + 1,
		},
		groupColumns,
	};
}
