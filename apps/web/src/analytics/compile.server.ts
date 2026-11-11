import type { AnalyticsQuery, Filter, MetricBehavior } from "./contracts";
import { DEFAULT_SERIES_LIMIT, INTERVALS, type Measure } from "./contracts";
import { type ParsedField, parseField } from "./validation";

const NS_PER_MS = 1_000_000n;

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
	cte: (name: string) => string,
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
		return `${cte("per_series")} AS (
  SELECT ${keys}, ${aggregate} AS value FROM ${cte("base")} WHERE v IS NOT NULL GROUP BY ${keys}
)`;
	}
	// Rates divide by the time the range covers within each bucket, so the current,
	// still-filling bucket and a range starting mid-bucket are not understated.
	const covered = timeseries
		? "((least(bucket + {step:UInt64}, {to:UInt64}) - greatest(bucket, {from:UInt64})) / 1e9)"
		: "{seconds:Float64}";
	const scale = measure.calculation === "rate" ? ` / ${covered}` : "";
	if (behavior === "delta")
		return `${cte("per_series")} AS (
  SELECT ${keys}, sum(v)${scale} AS value FROM ${cte("base")} WHERE v IS NOT NULL GROUP BY ${keys}
)`;
	// Cumulative counters: positive differences within one continuity segment. The first
	// point of a segment has no predecessor, so it contributes nothing.
	return `${cte("diffs")} AS (
  SELECT ${keys}, v - lagInFrame(v) OVER w AS d, row_number() OVER w AS n
  FROM ${cte("base")} WHERE v IS NOT NULL
  WINDOW w AS (PARTITION BY stream ORDER BY t, sample_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
${cte("per_series")} AS (
  SELECT ${keys}, sum(greatest(d, 0))${scale} AS value FROM ${cte("diffs")} WHERE n > 1 GROUP BY ${keys}
)`;
}

/** The stored kind and behavior of a measured metric. */
export interface MeasureScope {
	/** Stored kind of the measured metric, so mixed-kind names are never combined. */
	kind: number;
	behavior: MetricBehavior;
}

export interface CompiledQuery {
	sql: string;
	params: Record<string, string | number | string[]>;
	/** Output columns holding group values, in `groupBy` order. */
	groupColumns: string[];
}

/** One measure's rows: its CTEs and final selection, tagged with the measure's index. */
function measureSelect(
	query: AnalyticsQuery,
	measure: Measure,
	index: number,
	scope: MeasureScope,
	params: Params,
) {
	const cte = (name: string) => `m${index}_${name}`;
	const groupBy = query.groupBy ?? [];
	const groupColumns = groupBy.map((_, column) => `g${column}`);
	const groupSelect = groupBy
		.map(
			(field, column) =>
				`${fieldExpression(parseField(field), params)} AS ${groupColumns[column]}`,
		)
		.join(",\n    ");
	const filters = [...(query.filters ?? []), ...(measure.filters ?? [])].map(
		(filter) => filterExpression(filter, params),
	);
	// Timeseries buckets align to the interval; a table result is one bucket.
	const bucket =
		query.shape === "timeseries"
			? "intDiv(time_unix_nano, {step:UInt64}) * {step:UInt64}"
			: "toUInt64(0)";
	const groups = groupColumns.join(", ");
	const partition = groups ? `PARTITION BY ${groups}` : "";
	const ranked = cte("ranked");
	// Groups past the limit fold into one "Other" row per bucket, combined the same way.
	const selection =
		groups && query.other
			? `SELECT ${index} AS measure_index, ${groupColumns.map((column) => `if(rank <= {seriesLimit:UInt32}, ${column}, NULL) AS k_${column}`).join(", ")},
  rank > {seriesLimit:UInt32} AS other, toString(bucket) AS bucket_ns, ${measure.combine}(value) AS series_value, min(rank) AS series_rank
FROM ${ranked} GROUP BY ${groupColumns.map((column) => `k_${column}`).join(", ")}, other, bucket_ns`
			: `SELECT ${index} AS measure_index, ${groupColumns.map((column) => `${column} AS k_${column}`).join(", ")}${groups ? ", " : ""}0 AS other, toString(bucket) AS bucket_ns, value AS series_value, rank AS series_rank
FROM ${ranked} WHERE rank <= {seriesLimit:UInt32} + 1`;
	return `WITH ${cte("base")} AS (
  SELECT series_id AS series, stream_id AS stream,
    ${groupSelect ? `${groupSelect},\n    ` : ""}time_unix_nano AS t, sample_id,
    ${bucket} AS bucket, ${VALUE} AS v
  FROM metric_points FINAL
  WHERE project_id = {project:String}
    AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
    AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}
    AND metric_name = ${params.bind(measure.metric, "String")} AND CAST(metric_kind, 'Int16') = ${params.bind(scope.kind, "Int16")}${filters.map((filter) => `\n    AND ${filter}`).join("")}
),
${perSeries(measure, scope.behavior, cte, groups, query.shape === "timeseries")},
${cte("combined")} AS (
  SELECT ${groups ? `${groups}, ` : ""}bucket, ${measure.combine}(value) AS value
  FROM ${cte("per_series")} GROUP BY ${groups ? `${groups}, ` : ""}bucket
),
${ranked} AS (
  SELECT *, dense_rank() OVER (ORDER BY weight DESC${groups ? `, ${groups}` : ""}) AS rank
  FROM (SELECT *, sum(abs(value)) OVER (${partition}) AS weight FROM ${cte("combined")})
)
${selection}`;
}

/**
 * Compiles every measure of a validated query for one time window into a single
 * parameterized ClickHouse statement, so an insight costs one query per window
 * however many series it has. Rows carry `measure_index`; their order is unspecified.
 */
export function compileQuery(
	query: AnalyticsQuery,
	scopes: MeasureScope[],
	window: { projectId: string; from: Date; to: Date },
): CompiledQuery {
	const params = new Params();
	const sql = query.measures
		.map(
			(measure, index) =>
				`SELECT * FROM (\n${measureSelect(query, measure, index, scopes[index], params)}\n)`,
		)
		.join("\nUNION ALL\n");
	const from = BigInt(window.from.getTime()) * NS_PER_MS,
		to = BigInt(window.to.getTime()) * NS_PER_MS;
	const bucketSeconds =
		query.shape === "timeseries" && query.interval
			? INTERVALS[query.interval]
			: (window.to.getTime() - window.from.getTime()) / 1000;
	return {
		sql,
		params: {
			...params.values,
			project: window.projectId,
			from: from.toString(),
			to: to.toString(),
			step: (BigInt(Math.round(bucketSeconds)) * 1_000_000_000n).toString(),
			seconds: bucketSeconds,
			firstDay: Math.floor(window.from.getTime() / 86_400_000),
			lastDay: Math.floor((window.to.getTime() - 1) / 86_400_000),
			// One extra group reveals whether the limit cut any series.
			seriesLimit: query.limit ?? DEFAULT_SERIES_LIMIT,
		},
		groupColumns: (query.groupBy ?? []).map((_, column) => `k_g${column}`),
	};
}
