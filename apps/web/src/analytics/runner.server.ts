import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { aggregateGroups, PERCENTILE_LEVELS } from "./aggregate";
import { compileMeasure, type MeasureScope } from "./compile.server";
import {
	type AnalyticsQuery,
	DEFAULT_SERIES_LIMIT,
	type ExecutionPeriod,
	INTERVALS,
	MAX_RANGE_SECONDS,
	MAX_SERIES,
	type QueryResult,
	type SeriesResult,
} from "./contracts";
import { metricDefinitions } from "./discovery.server";
import { executionPeriods } from "./execution-source.server";
import { formulaSeries } from "./formula-series";
import {
	ALLOWED_CALCULATIONS,
	assertResultSize,
	comparisonRange,
	rangeBuckets,
	resolveRange,
} from "./validation";

// Analyses may read more rows than the point reader, but time, memory and threads stay
// within the telemetry_read profile's constraints, which ClickHouse enforces anyway.
const SETTINGS = {
	max_execution_time: 6,
	max_threads: 4,
	max_memory_usage: "268435456",
	max_rows_to_read: "20000000",
	max_bytes_to_read: "2147483648",
	read_overflow_mode: "throw",
	max_result_rows: "250000",
	max_result_bytes: "33554432",
	result_overflow_mode: "throw",
	max_rows_to_group_by: "2000000",
	group_by_overflow_mode: "throw",
	max_bytes_before_external_group_by: "0",
	max_bytes_before_external_sort: "0",
	output_format_json_quote_64bit_integers: 1,
	// Duplicates share a timestamp, so a day partition holds all copies of a point and
	// FINAL can merge each partition alone: about twice as fast on one thread.
	do_not_merge_across_partitions_select_final: 1,
} as const;
/** Maps ClickHouse failures to operation errors; limits never yield partial results. */
export function analyticsError(error: unknown, signal?: AbortSignal): never {
	if (error instanceof OperationError || error instanceof InputError)
		throw error;
	if (signal?.aborted)
		throw new OperationError("CANCELLED", "Analytics request cancelled");
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	if (["159", "160"].includes(code))
		throw new OperationError("TIMEOUT", "Analytics deadline exceeded");
	if (["158", "202", "241", "252", "307", "396"].includes(code))
		throw new OperationError("CAPACITY", "Analytics capacity exceeded");
	throw new OperationError("UNAVAILABLE", "Analytics is unavailable");
}

interface Window {
	from: Date;
	to: Date;
	comparison: boolean;
	/** Added to comparison buckets so they line up with the current window. */
	shiftMs: number;
	/** An aligned execution: only its points, in buckets counted from `from`. */
	execution?: string;
}

type Row = Record<string, string | number | null>;

const number = (value: string | number | null | undefined) =>
	value === null || value === undefined ? null : Number(value);

/** One bucket's value, with its band across sources when the query asks for one. */
function pointOf(row: Row, query: AnalyticsQuery, window: Window) {
	return {
		bucketMs:
			query.shape === "timeseries"
				? Number(BigInt(String(row.bucket_ns)) / 1_000_000n) + window.shiftMs
				: null,
		value: number(row.series_value),
		...(query.spread
			? { low: number(row.series_low), high: number(row.series_high) }
			: {}),
	};
}

/** A percentile across too few sources is just their largest value; count them. */
function countPercentile(
	entry: SeriesResult,
	measure: AnalyticsQuery["measures"][number],
	row: Row,
	other: boolean,
) {
	const level = PERCENTILE_LEVELS[measure.combine];
	if (level === undefined || other || row.series_sources === null) return;
	entry.percentile = {
		level,
		values: Math.max(entry.percentile?.values ?? 0, Number(row.series_sources)),
	};
}

/** Every measure's series for one window. */
async function readWindow(
	query: AnalyticsQuery,
	scopes: MeasureScope[],
	projectId: string,
	window: Window,
	connection: ClickHouseClient,
	abort: AbortSignal,
) {
	// One statement per measure, one after another: every statement has the reader's
	// memory limit, and a single statement over several metrics under FINAL can exceed it.
	const rows: Record<string, string | number | null>[] = [];
	let groupColumns: string[] = [];
	const windowQuery = window.execution
		? {
				...query,
				filters: [
					...(query.filters ?? []),
					{
						field: "execution",
						op: "eq" as const,
						values: [window.execution],
					},
				],
			}
		: query;
	for (const [index, measure] of query.measures.entries()) {
		const compiled = compileMeasure(windowQuery, measure, scopes[index], {
			projectId,
			from: window.from,
			to: window.to,
			...(window.execution ? { origin: window.from } : {}),
		});
		groupColumns = compiled.groupColumns;
		const result = await connection.query({
			query: compiled.sql,
			format: "JSONEachRow",
			query_params: compiled.params,
			abort_signal: abort,
			clickhouse_settings: SETTINGS,
		});
		for (const row of await result.json<
			Record<string, string | number | null>
		>())
			rows.push({ ...row, measure_index: index });
	}
	const limit = query.limit ?? DEFAULT_SERIES_LIMIT;
	const groups = new Map<string, SeriesResult & { rank: number }>();
	let limited = false;
	for (const row of rows) {
		const other = Number(row.other) === 1;
		const rank = Number(row.series_rank);
		if (other) limited = true;
		else if (rank > limit) {
			limited = true;
			continue;
		}
		const measure = query.measures[Number(row.measure_index)];
		const group = groupColumns.map((column) =>
			row[column] === null ? null : String(row[column]),
		);
		const key = JSON.stringify([measure.name, group, other]);
		let entry = groups.get(key);
		if (!entry) {
			entry = {
				measure: measure.name,
				group,
				...(other ? { other: true } : {}),
				...(window.comparison ? { comparison: true } : {}),
				...(window.execution ? { execution: window.execution } : {}),
				points: [],
				rank,
			};
			groups.set(key, entry);
		}
		countPercentile(entry, measure, row, other);
		entry.points.push(pointOf(row, query, window));
	}
	// Rows arrive unordered: series follow the query's measures, then rank.
	const series = [...groups.values()]
		.sort(
			(a, b) =>
				query.measures.findIndex((measure) => measure.name === a.measure) -
					query.measures.findIndex((measure) => measure.name === b.measure) ||
				a.rank - b.rank,
		)
		.map(({ rank: _, ...entry }) => ({
			...entry,
			points: entry.points.sort(
				(a, b) => (a.bucketMs ?? 0) - (b.bucketMs ?? 0),
			),
		}));
	return { series, limited };
}

// Collectors report this once per collection cycle, whatever else they measure.
const HEARTBEAT = "recount.collection.discovered.processes";

/** Buckets per node in which its collector reported; null when unknown or unavailable. */
async function coverage(
	connection: ClickHouseClient,
	projectId: string,
	from: Date,
	to: Date,
	step: number,
	signal: AbortSignal,
): Promise<Record<string, number[]> | null> {
	const ns = (date: Date) => (BigInt(date.getTime()) * 1_000_000n).toString();
	try {
		const result = await connection.query({
			query: `SELECT source_id AS node,
  arraySort(groupUniqArray(toString(intDiv(time_unix_nano, {step:UInt64}) * {step:UInt64}))) AS buckets
FROM metric_points
WHERE project_id = {project:String}
  AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
  AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}
  AND metric_name = {heartbeat:String}
GROUP BY node
LIMIT 500`,
			format: "JSONEachRow",
			query_params: {
				project: projectId,
				firstDay: Math.floor(from.getTime() / 86_400_000),
				lastDay: Math.floor(to.getTime() / 86_400_000),
				from: ns(from),
				to: ns(to),
				step: (BigInt(step) * 1_000_000_000n).toString(),
				heartbeat: HEARTBEAT,
			},
			abort_signal: signal,
			clickhouse_settings: SETTINGS,
		});
		const rows = await result.json<{ node: string; buckets: string[] }>();
		// No heartbeat at all means this project's sources don't send one, not that every
		// node was offline.
		if (!rows.length) return null;
		return Object.fromEntries(
			rows.map((row) => [
				row.node,
				row.buckets.map((bucket) => Number(BigInt(bucket) / 1_000_000n)),
			]),
		);
	} catch {
		if (signal.aborted)
			throw new OperationError("CANCELLED", "Analytics request cancelled");
		return null;
	}
}

/**
 * One window per execution, over its period and in the requested order. Unknown keys
 * are not found, like any other execution outside the project.
 */
async function executionWindows(
	query: AnalyticsQuery,
	keys: string[],
	projectId: string,
	connection: ClickHouseClient,
	abort: AbortSignal,
) {
	const periods = await executionPeriods(
		connection,
		projectId,
		keys,
		abort,
		SETTINGS,
	);
	const windows = keys.map((key): Window & { period: ExecutionPeriod } => {
		const period = periods.get(key);
		if (!period) throw new OperationError("NOT_FOUND", "Execution not found");
		if (period.to.getTime() - period.from.getTime() > MAX_RANGE_SECONDS * 1000)
			throw new InputError(
				"INVALID_TIME_RANGE",
				"Execution is too long to compare",
			);
		return {
			from: period.from,
			// Open memberships include their last sighting.
			to: new Date(period.to.getTime() + 1),
			comparison: false,
			shiftMs: 0,
			execution: key,
			period: { execution: key, ...period },
		};
	});
	// One result holds every execution's buckets, so the limit applies to their sum.
	assertResultSize(
		query,
		windows.reduce(
			(total, window) =>
				total + rangeBuckets(window, query.shape, query.interval),
			0,
		),
	);
	return windows;
}

/** The windows a query reads: its range, then its calendar comparison or executions. */
async function queryWindows(
	query: AnalyticsQuery,
	projectId: string,
	connection: ClickHouseClient,
	abort: AbortSignal,
) {
	if ("executions" in query.range) {
		const windows = await executionWindows(
			query,
			query.range.executions,
			projectId,
			connection,
			abort,
		);
		const longest = Math.max(
			...windows.map((window) => window.to.getTime() - window.from.getTime()),
		);
		return {
			windows,
			from: new Date(0),
			to: new Date(longest),
			compared: null,
			executions: windows.map((window) => window.period),
		};
	}
	const { from, to } = resolveRange(query.range);
	const compared = query.compare
		? comparisonRange(query.compare, from, to)
		: null;
	const windows: Window[] = [
		{ from, to, comparison: false, shiftMs: 0 },
		...(compared
			? [
					{
						...compared,
						comparison: true,
						shiftMs: from.getTime() - compared.from.getTime(),
					},
				]
			: []),
	];
	return { windows, from, to, compared, executions: undefined };
}

/** Runs a validated query for an already authorized project. */
export async function runQuery(
	projectId: string,
	input: AnalyticsQuery,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<QueryResult> {
	if (signal?.aborted)
		throw new OperationError("CANCELLED", "Analytics request cancelled");
	// An aggregation reads up to the largest groups allowed, never folded into Other.
	const query = input.aggregate
		? { ...input, limit: MAX_SERIES, other: false }
		: input;
	const deadline = AbortSignal.timeout(10_000);
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		const { windows, from, to, compared, executions } = await queryWindows(
			query,
			projectId,
			connection,
			abort,
		);
		const definitions = await metricDefinitions(
			connection,
			projectId,
			query.measures.map((measure) => measure.metric),
			abort,
		);
		const scopes = query.measures.map((measure) => {
			const definition = definitions.get(measure.metric);
			if (!definition)
				throw new InputError(
					"INVALID_QUERY",
					"Metric not found in this project",
				);
			if (
				!ALLOWED_CALCULATIONS[definition.behavior].includes(measure.calculation)
			)
				throw new InputError(
					"INVALID_CALCULATION",
					"Calculation does not apply to this metric",
				);
			return definition;
		});
		const series: SeriesResult[] = [];
		let limited = false;
		for (const window of windows) {
			const read = await readWindow(
				query,
				scopes,
				projectId,
				window,
				connection,
				abort,
			);
			series.push(...read.series);
			limited ||= read.limited;
		}
		const measures: QueryResult["measures"] = query.measures.map(
			(measure, index) => ({
				name: measure.name,
				metric: measure.metric,
				// A count of sources has no unit, whatever the metric measures.
				unit: measure.combine === "count" ? "1" : scopes[index].unit,
				calculation: measure.calculation,
			}),
		);
		const all = [...series, ...formulaSeries(query, series)];
		return {
			shape: query.shape,
			from,
			to,
			// Collector reports are absolute in time, so elapsed buckets have no coverage.
			coverage:
				query.shape === "timeseries" && query.interval && !executions
					? await coverage(
							connection,
							projectId,
							from,
							to,
							INTERVALS[query.interval],
							abort,
						)
					: null,
			bucketSeconds:
				query.shape === "timeseries" && query.interval
					? INTERVALS[query.interval]
					: null,
			groupBy: query.groupBy ?? [],
			measures,
			formulas: query.formulas ?? [],
			series: query.aggregate
				? aggregateGroups(all, query.aggregate, query.spread)
				: all,
			...(query.aggregate ? { aggregate: query.aggregate } : {}),
			limited,
			compared,
			...(executions ? { executions } : {}),
		};
	} catch (error) {
		analyticsError(error, signal);
	}
}
