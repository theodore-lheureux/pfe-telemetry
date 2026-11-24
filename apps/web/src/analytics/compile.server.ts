import type { AnalyticsQuery, Filter, MetricBehavior } from "./contracts";
import {
	type Combine,
	DEFAULT_SERIES_LIMIT,
	INTERVALS,
	type Measure,
} from "./contracts";
import { executionPointSource } from "./execution-source.server";
import {
	POINT_WINDOW,
	SERIES_WINDOW,
	seriesPointSource,
	streamEvidenceSource,
} from "./series-source.server";
import { type ParsedField, parseField } from "./validation";

// Combining the sources' values in a bucket. Percentiles are exact over those values.
const COMBINE_SQL: Record<Combine, string> = {
	sum: "sum(value)",
	avg: "avg(value)",
	count: "count(value)",
	min: "min(value)",
	max: "max(value)",
	p50: "quantileExact(0.5)(value)",
	p90: "quantileExact(0.9)(value)",
	p95: "quantileExact(0.95)(value)",
	p99: "quantileExact(0.99)(value)",
};
// A bucket's band across the sources it combines, when the query asks for one. The
// column is qualified, since `value` alone names the combined value in that SELECT.
const SPREAD_SQL = {
	range: ["min(per_series.value)", "max(per_series.value)"],
	middle: [
		"quantileExact(0.25)(per_series.value)",
		"quantileExact(0.75)(per_series.value)",
	],
};

// "Other" folds groups that were each combined already, so their source counts add up.
const OTHER_SQL: Record<Combine, string> = {
	...COMBINE_SQL,
	count: "sum(value)",
};

// Missing or no-recorded values stay NULL and are skipped, never counted as zero.
const VALUE = `if(bitAnd(flags, 1) = 0,
    if(isNull(int_value), double_value, toFloat64(int_value)), NULL)`;

/**
 * A percentile of pooled bucket counts, interpolated linearly within the bucket that holds
 * its rank. `cumulative` counts observations up to each bound, then in total.
 */
function histogramQuantile(cumulative: string, bounds: string, level: number) {
	const target = `${cumulative}[-1] * ${level}`;
	const hit = `arrayFirstIndex(n -> n >= ${target}, ${cumulative})`;
	return `multiIf(${cumulative}[-1] = 0 OR empty(${bounds}), NULL,
    ${hit} = 1, ${bounds}[1],
    ${hit} > length(${bounds}), ${bounds}[-1],
    ${bounds}[${hit} - 1] + (${bounds}[${hit}] - ${bounds}[${hit} - 1])
      * (${target} - ${cumulative}[${hit} - 1]) / (${cumulative}[${hit}] - ${cumulative}[${hit} - 1]))`;
}

const COUNTS = (cumulative: string) =>
	`arrayPopFront(arrayDifference(arrayPushFront(${cumulative}, 0)))`;
// A heatmap also returns each bucket's counts, on bounds every point shares: for a
// group, and for the groups folded into Other.
const HEATMAP_COLUMNS = [
	`, ${COUNTS("cumulative")} AS series_counts, shared AS series_bounds`,
	`, ${COUNTS("sumForEach(cumulative)")} AS series_counts, any(shared) AS series_bounds`,
];
/** A histogram's value from pooled counts: a percentile, the mean or the observation count. */
function histogramValue(
	calculation: Measure["calculation"],
	cumulative: string,
	shared: string,
	total: string,
) {
	if (calculation === "count") return `${cumulative}[-1]`;
	if (calculation === "avg") return `${total} / nullIf(${cumulative}[-1], 0)`;
	return histogramQuantile(
		cumulative,
		shared,
		Number(calculation.slice(1)) / 100,
	);
}

// Histograms pool their bucket counts per group and bucket. Layouts are reduced to the
// bounds they all share, so every point's counts line up.
function histogramCombined(
	columns: string,
	source: string,
	filters: string[],
	keys: string,
	calculation: Measure["calculation"],
) {
	return `WITH base AS (
  SELECT ${columns}, explicit_bounds AS bounds,
    -- Each stream's scans in a bucket average into one, so counts are processes per scan.
    count() OVER (PARTITION BY stream_id, bucket) AS scans,
    arrayMap(n -> toFloat64(n) / scans, bucket_counts) AS counts,
    if(bitTest(statistics_present, 1), \`sum\`, NULL) / scans AS total
  FROM ${source}
  WHERE ${[...filters, "bitAnd(flags, 1) = 0", "length(explicit_bounds) <= 64", "length(bucket_counts) = length(explicit_bounds) + 1"].join(" AND ")}
),
layouts AS (
  SELECT ${keys}bucket, bounds, arrayCumSum(sumForEach(counts)) AS running, sum(total) AS total,
    arraySort(groupArrayIntersect(bounds) OVER ()) AS common
  FROM base GROUP BY ${keys}bucket, bounds
),
pooled AS (
  SELECT ${keys}bucket, any(common) AS shared, sum(total) AS total,
    sumForEach(arrayPushBack(arrayMap(b -> running[indexOf(bounds, b)], common), running[-1])) AS cumulative
  FROM layouts GROUP BY ${keys}bucket
),
combined AS (
  SELECT *, ${histogramValue(calculation, "cumulative", "shared", "total")} AS value,
    NULL AS low, NULL AS high, NULL AS sources
  FROM pooled
)`;
}

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

function continuityColumn(field: ParsedField) {
	if (field.type !== "attribute") return undefined;
	const root = field.key.split("/", 1)[0];
	if (
		field.scope === "resource" &&
		["recount.host.boot_id", "recount.collection.epoch_id"].includes(root)
	)
		return "resource_continuity";
	if (field.scope === "point" && root === "recount.counter.segment_id")
		return "point_continuity";
}

export function isContinuityField(field: string) {
	return continuityColumn(parseField(field)) !== undefined;
}

export function isPointField(field: string) {
	return (
		field === "execution" || continuityColumn(parseField(field)) !== undefined
	);
}

function fieldExpression(field: ParsedField, params: Params) {
	if (field.type === "core") {
		switch (field.name) {
			case "execution":
				return "execution_keys";
			case "node":
				return "source_id";
			case "host":
				return "nullIf(host_id, '')";
			case "resource.id":
				return "resource_id";
			case "resource.kind":
				return "toString(toUInt8(resource_kind))";
			case "scope.name":
				return "scope_name";
		}
	}
	const continuity = continuityColumn(field);
	const attributes =
		field.scope === "resource" ? "resource_attributes" : "point_attributes";
	const column = continuity
		? `arrayMap(c -> c.node, if(throwIf(coalesce(evidence_present, 0) = 0, 'Stream evidence is not yet available') = 0, ${continuity}, []))`
		: attributes;
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
	if (filter.field === "execution") {
		switch (filter.op) {
			case "exists":
				return "notEmpty(execution_keys)";
			case "not_exists":
				return "empty(execution_keys)";
			case "eq":
			case "in":
				return `hasAny(execution_keys, ${params.bind(filter.values ?? [], "Array(String)")})`;
			case "neq":
			case "not_in":
				return `NOT hasAny(execution_keys, ${params.bind(filter.values ?? [], "Array(String)")})`;
		}
	}
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
			last: "argMax(v, tuple(t, stream, storage_series))",
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
		? "((least(bucket + {step:UInt64}, {to:UInt64}) - greatest(bucket, {from:UInt64})) / 1e3)"
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
  WINDOW w AS (PARTITION BY stream${groups ? `, ${groups}` : ""} ORDER BY t, storage_series
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
per_series AS (
  SELECT ${keys}, sum(greatest(d, 0))${scale} AS value FROM diffs WHERE n > 1 GROUP BY ${keys}
)`;
}

/** The stored kind and behavior of a measured metric. */
export interface MeasureScope {
	unit?: string;
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

function executionGroup(filters: Filter[], params: Params) {
	const selected = filters
		.filter(
			(filter) =>
				filter.field === "execution" &&
				(filter.op === "eq" || filter.op === "in"),
		)
		.flatMap((filter) => filter.values ?? []);
	// Point filters remain conjunctive; the breakdown shows their selected keys.
	const keys = selected.length
		? `arrayFilter(k -> has(${params.bind([...new Set(selected)], "Array(String)")}, k), execution_keys)`
		: "execution_keys";
	return `arrayJoin(if(empty(${keys}), [NULL], arrayMap(k -> toNullable(k), ${keys})))`;
}

/** One measure's rows: its CTEs and final selection. */
function measureSelect(
	query: AnalyticsQuery,
	measure: Measure,
	scope: MeasureScope,
	params: Params,
) {
	const groupBy = query.groupBy ?? [];
	const allFilters = [...(query.filters ?? []), ...(measure.filters ?? [])];
	const usesExecution =
		groupBy.includes("execution") ||
		allFilters.some((filter) => filter.field === "execution");
	const usesEvidence = [
		...groupBy,
		...allFilters.map(({ field }) => field),
	].some((field) => continuityColumn(parseField(field)) !== undefined);
	const metric = params.bind(measure.metric, "String");
	const histogram =
		scope.behavior === "histogram" || scope.behavior === "population";
	const unit = histogram
		? ` AND temporality = 1 AND unit = ${params.bind(scope.unit ?? "", "String")}`
		: "";
	const groupColumns = groupBy.map((_, column) => `g${column}`);
	const staticGroups = groupBy.flatMap((field, column) =>
		isPointField(field)
			? []
			: [
					`${fieldExpression(parseField(field), params)} AS ${groupColumns[column]}`,
				],
	);
	const seriesFilters = allFilters
		.filter((filter) => !isPointField(filter.field))
		.map((filter) => ` AND ${filterExpression(filter, params)}`)
		.join("");
	const pointFilters = allFilters
		.filter((filter) => isPointField(filter.field))
		.map((filter) => filterExpression(filter, params));
	const groupSelect = groupColumns
		.map((name, index) => {
			const field = groupBy[index];
			if (field === "execution")
				return `${executionGroup(allFilters, params)} AS ${name}`;
			if (isPointField(field))
				return `${fieldExpression(parseField(field), params)} AS ${name}`;
			return name;
		})
		.join(", ");
	const pointSource = seriesPointSource(
		`${SERIES_WINDOW} AND metric_name = ${metric} AND CAST(metric_kind, 'Int16') = ${params.bind(scope.kind, "Int16")}${unit}${seriesFilters}`,
		POINT_WINDOW,
		[
			"s.logical_series_id",
			...(usesExecution
				? ["s.source_id", "s.resource_id", "s.resource_kind"]
				: []),
			...groupColumns
				.filter((_, index) => !isPointField(groupBy[index]))
				.map((column) => `s.${column}`),
		].join(", "),
		`AND metric_name = ${metric}`,
		staticGroups,
	);
	const points = usesEvidence
		? `SELECT * FROM ${streamEvidenceSource(pointSource)}`
		: pointSource;
	// Timeseries buckets align to the interval; a table result is one bucket.
	const bucket =
		query.shape === "timeseries"
			? "intDiv(time_unix_milli, {step:UInt64}) * {step:UInt64}"
			: "toUInt64(0)";
	const source = usesExecution
		? executionPointSource(points, histogram)
		: `(${points})`;
	const groups = groupColumns.join(", ");
	const keys = groups ? `${groups}, ` : "";
	const columns = groupSelect ? `${groupSelect}, ` : "";
	const layout = query.heatmap && histogram ? HEATMAP_COLUMNS : ["", ""];
	// A sum or count is larger than each source, so their band would not surround it.
	const banded =
		query.spread && measure.combine !== "sum" && measure.combine !== "count";
	const [low, high] =
		banded && query.spread ? SPREAD_SQL[query.spread] : ["NULL", "NULL"];
	const partition = groups ? `PARTITION BY ${groups}` : "";
	// Groups past the limit fold into one "Other" row per bucket, combined the same way.
	const otherValue = histogram
		? histogramValue(
				measure.calculation,
				"sumForEach(cumulative)",
				"any(shared)",
				"sum(total)",
			)
		: OTHER_SQL[measure.combine];
	const selection =
		groups && query.other
			? `SELECT ${groupColumns.map((column) => `if(rank <= {seriesLimit:UInt32}, ${column}, NULL) AS k_${column}`).join(", ")},
  rank > {seriesLimit:UInt32} AS other, toString(bucket) AS bucket_ms, ${otherValue} AS series_value, min(rank) AS series_rank,
  if(other, NULL, any(low)) AS series_low, if(other, NULL, any(high)) AS series_high,
  if(other, NULL, any(sources)) AS series_sources${layout[1]}
FROM ranked GROUP BY ${groupColumns.map((column) => `k_${column}`).join(", ")}, other, bucket_ms`
			: `SELECT ${groupColumns.map((column) => `${column} AS k_${column}`).join(", ")}${groups ? ", " : ""}0 AS other, toString(bucket) AS bucket_ms, value AS series_value, rank AS series_rank,
  low AS series_low, high AS series_high, sources AS series_sources${layout[0]}
FROM ranked WHERE rank <= {seriesLimit:UInt32} + 1`;
	const combined = histogram
		? histogramCombined(
				`${columns}${bucket} AS bucket`,
				source,
				pointFilters,
				keys,
				measure.calculation,
			)
		: `WITH base AS (
  SELECT logical_series_id AS series, stream_id AS stream, series_id AS storage_series,
    ${columns}time_unix_milli AS t,
    ${bucket} AS bucket, ${VALUE} AS v
  FROM ${source}
  ${pointFilters.length ? `WHERE ${pointFilters.join(" AND ")}` : ""}
),
${perSeries(measure, scope.behavior, groups, query.shape === "timeseries")},
combined AS (
  SELECT ${keys}bucket, ${COMBINE_SQL[measure.combine]} AS value,
    ${low} AS low, ${high} AS high, count(per_series.value) AS sources
  FROM per_series GROUP BY ${keys}bucket
)`;
	return `${combined},
ranked AS (
  SELECT *, dense_rank() OVER (ORDER BY weight DESC${groups ? `, ${groups}` : ""}) AS rank
  FROM (SELECT *, sum(abs(value)) OVER (${partition}) AS weight FROM combined)
)
${selection}`;
}

/**
 * Compiles one measure of a validated query for one time window into a parameterized
 * ClickHouse statement. Each measure runs alone, within the reader's per-query limits.
 */
export function compileMeasure(
	query: AnalyticsQuery,
	measure: Measure,
	scope: MeasureScope,
	window: { projectId: string; from: Date; to: Date },
): CompiledQuery {
	const params = new Params();
	const sql = measureSelect(query, measure, scope, params);
	const from = BigInt(window.from.getTime()),
		to = BigInt(window.to.getTime());
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
			step: (BigInt(Math.round(bucketSeconds)) * 1_000n).toString(),
			seconds: bucketSeconds,
			firstDay: Math.floor(window.from.getTime() / 86_400_000),
			lastDay: Math.floor((window.to.getTime() - 1) / 86_400_000),
			// One extra group reveals whether the limit cut any series.
			seriesLimit: query.limit ?? DEFAULT_SERIES_LIMIT,
		},
		groupColumns: (query.groupBy ?? []).map((_, column) => `k_g${column}`),
	};
}
