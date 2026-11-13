import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { aggregateGroups } from "./aggregate";
import { compileMeasure, type MeasureScope } from "./compile.server";
import {
	type AnalyticsQuery,
	DEFAULT_SERIES_LIMIT,
	INTERVALS,
	MAX_SERIES,
	type QueryResult,
	type SeriesResult,
} from "./contracts";
import { metricDefinitions } from "./discovery.server";
import { evaluateFormula, parseFormula } from "./formula";
import {
	ALLOWED_CALCULATIONS,
	comparisonRange,
	resolveRange,
} from "./validation";

// Analyses may read more rows than the point reader, but time, memory and threads stay
// within the telemetry_read profile's constraints, which ClickHouse enforces anyway.
const SETTINGS = {
	max_execution_time: 6,
	max_threads: 1,
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
} as const;
/** Maps ClickHouse failures to operation errors; limits never yield partial results. */
function analyticsError(error: unknown, signal?: AbortSignal): never {
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
	for (const [index, measure] of query.measures.entries()) {
		const compiled = compileMeasure(query, measure, scopes[index], {
			projectId,
			from: window.from,
			to: window.to,
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
				points: [],
				rank,
			};
			groups.set(key, entry);
		}
		entry.points.push({
			bucketMs:
				query.shape === "timeseries"
					? Number(BigInt(String(row.bucket_ns)) / 1_000_000n) + window.shiftMs
					: null,
			value: row.series_value === null ? null : Number(row.series_value),
		});
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

/** Applies each formula to the measure series that share a group and bucket. */
function formulaSeries(
	query: AnalyticsQuery,
	series: SeriesResult[],
): SeriesResult[] {
	const results: SeriesResult[] = [];
	for (const formula of query.formulas ?? []) {
		const node = parseFormula(
			formula.expression,
			query.measures.map((measure) => measure.name),
		);
		// Inputs keyed by window, group and bucket; a formula never mixes windows.
		const inputs = new Map<string, Map<string, number | null>>();
		const keys = new Map<
			string,
			{ group: (string | null)[]; other: boolean; comparison: boolean }
		>();
		const buckets = new Map<string, Set<number | null>>();
		for (const entry of series) {
			const key = JSON.stringify([
				entry.group,
				entry.other ?? false,
				entry.comparison ?? false,
			]);
			keys.set(key, {
				group: entry.group,
				other: entry.other ?? false,
				comparison: entry.comparison ?? false,
			});
			const bucketSet = buckets.get(key) ?? new Set();
			for (const point of entry.points) {
				bucketSet.add(point.bucketMs);
				const values = inputs.get(`${key}|${point.bucketMs}`) ?? new Map();
				values.set(entry.measure, point.value);
				inputs.set(`${key}|${point.bucketMs}`, values);
			}
			buckets.set(key, bucketSet);
		}
		for (const [key, identity] of keys) {
			const points = [...(buckets.get(key) ?? [])]
				.sort((a, b) => (a ?? 0) - (b ?? 0))
				.map((bucketMs) => {
					const values = inputs.get(`${key}|${bucketMs}`);
					return {
						bucketMs,
						value: evaluateFormula(node, (name) => values?.get(name) ?? null),
					};
				});
			results.push({
				measure: formula.name,
				group: identity.group,
				...(identity.other ? { other: true } : {}),
				...(identity.comparison ? { comparison: true } : {}),
				points,
			});
		}
	}
	return results;
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
	const deadline = AbortSignal.timeout(10_000);
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
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
			coverage:
				query.shape === "timeseries" && query.interval
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
			series: query.aggregate ? aggregateGroups(all, query.aggregate) : all,
			...(query.aggregate ? { aggregate: query.aggregate } : {}),
			limited,
			compared,
		};
	} catch (error) {
		analyticsError(error, signal);
	}
}
