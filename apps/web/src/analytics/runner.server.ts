import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { aggregateGroups, PERCENTILE_LEVELS } from "./aggregate";
import { capabilities } from "./capabilities";
import { compileMeasure, type MeasureScope } from "./compile.server";
import {
	type AnalyticsQuery,
	DEFAULT_SERIES_LIMIT,
	INTERVALS,
	MAX_SERIES,
	type QueryResult,
	type SeriesResult,
} from "./contracts";
import { omissionMeasure } from "./coverage";
import { heartbeatDefinition, metricDefinitions } from "./discovery.server";
import { formulaSeries } from "./formula-series";
import { pipelineIngestedThrough } from "./ingested-through.server";
import {
	POINT_FINAL_SETTINGS,
	POINT_WINDOW,
	SERIES_WINDOW,
	seriesPointSource,
} from "./series-source.server";
import { comparisonRange, resolveRange } from "./validation";

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
	...POINT_FINAL_SETTINGS,
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
}

type Row = Record<string, string | number | null | number[] | undefined>;

const number = (value: Row[string]) =>
	typeof value === "number" || typeof value === "string" ? Number(value) : null;

/** One bucket's value, with its band across sources when the query asks for one. */
function pointOf(row: Row, query: AnalyticsQuery, window: Window) {
	return {
		bucketMs:
			query.shape === "timeseries"
				? Number(BigInt(String(row.bucket_ms))) + window.shiftMs
				: null,
		value: number(row.series_value),
		...(query.spread
			? { low: number(row.series_low), high: number(row.series_high) }
			: {}),
		...(Array.isArray(row.series_counts) ? { counts: row.series_counts } : {}),
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
	const rows: Row[] = [];
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
		for (const row of await result.json<Row>())
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
				...(Array.isArray(row.series_bounds)
					? { bounds: row.series_bounds }
					: {}),
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

/** Buckets per node in which its collector reported; null when unknown or unavailable. */
async function coverage(
	connection: ClickHouseClient,
	projectId: string,
	from: Date,
	to: Date,
	step: number,
	signal: AbortSignal,
	heartbeat: string,
): Promise<Record<string, number[]> | null> {
	const millis = (date: Date) => String(date.getTime());
	try {
		const result = await connection.query({
			query: `SELECT source_id AS node,
  arraySort(groupUniqArray(toString(intDiv(time_unix_milli, {step:UInt64}) * {step:UInt64}))) AS buckets
FROM (${seriesPointSource(`${SERIES_WINDOW} AND metric_name = {heartbeat:String}`, POINT_WINDOW, "s.source_id", "AND metric_name = {heartbeat:String}")})
GROUP BY node
LIMIT 500`,
			format: "JSONEachRow",
			query_params: {
				project: projectId,
				firstDay: Math.floor(from.getTime() / 86_400_000),
				lastDay: Math.floor(to.getTime() / 86_400_000),
				from: millis(from),
				to: millis(to),
				step: (BigInt(step) * 1_000n).toString(),
				heartbeat,
			},
			abort_signal: signal,
			clickhouse_settings: SETTINGS,
		});
		const rows = await result.json<{ node: string; buckets: string[] }>();
		return Object.fromEntries(
			rows.map((row) => [
				row.node,
				row.buckets.map((bucket) => Number(BigInt(bucket))),
			]),
		);
	} catch {
		if (signal.aborted)
			throw new OperationError("CANCELLED", "Analytics request cancelled");
		return null;
	}
}

async function scopesForQuery(
	connection: ClickHouseClient,
	projectId: string,
	query: AnalyticsQuery,
	signal: AbortSignal,
) {
	const definitions = await metricDefinitions(
		connection,
		projectId,
		query.measures.map(({ metric }) => metric),
		signal,
	);
	const companions = query.heatmap
		? query.measures.flatMap(({ name, metric }) =>
				omissionMeasure(name, definitions.get(metric)?.presentation?.coverage),
			)
		: [];
	if (companions.length) {
		const counters = await metricDefinitions(
			connection,
			projectId,
			companions.map(({ metric }) => metric),
			signal,
		);
		for (const [name, definition] of counters)
			definitions.set(name, definition);
		query = {
			...query,
			measures: [
				...query.measures,
				...companions.filter(({ metric }) => definitions.has(metric)),
			],
		};
	}
	const scopes = query.measures.map((measure) => {
		const definition = definitions.get(measure.metric);
		if (!definition)
			throw new InputError("INVALID_QUERY", "Metric not found in this project");
		if (!capabilities(definition).calculations.includes(measure.calculation))
			throw new InputError(
				"INVALID_CALCULATION",
				"Calculation does not apply to this metric",
			);
		return definition;
	});
	return { query, scopes };
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
	const requested = input.aggregate
		? { ...input, limit: MAX_SERIES, other: false }
		: input;
	const { from, to } = resolveRange(requested.range);
	const compared = requested.compare
		? comparisonRange(requested.compare, from, to)
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
		const bucketSeconds =
			requested.shape === "timeseries" && requested.interval
				? INTERVALS[requested.interval]
				: null;
		const watermark = bucketSeconds ? pipelineIngestedThrough() : null;
		const [{ query, scopes }, heartbeat] = await Promise.all([
			scopesForQuery(connection, projectId, requested, abort),
			bucketSeconds
				? heartbeatDefinition(connection, projectId, abort)
				: undefined,
		]);
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
				presentation: scopes[index].presentation,
				// Source counts have no unit; observation counts use the unit's annotation.
				unit:
					measure.combine === "count" && measure.calculation !== "count"
						? ""
						: scopes[index].unit,
				calculation: measure.calculation,
			}),
		);
		const all = [...series, ...formulaSeries(query, series)];
		const ingestedThrough = await watermark;
		return {
			shape: query.shape,
			from,
			to,
			coverage:
				bucketSeconds && heartbeat && heartbeat.firstSeen < to
					? await coverage(
							connection,
							projectId,
							from,
							to,
							bucketSeconds,
							abort,
							heartbeat.name,
						)
					: null,
			ingestedThrough:
				ingestedThrough ??
				latestHeartbeatBucket(heartbeat?.lastSeen, bucketSeconds),
			bucketSeconds,
			groupBy: query.groupBy ?? [],
			measures,
			formulas: query.formulas ?? [],
			series: query.aggregate
				? aggregateGroups(all, query.aggregate, query.spread)
				: all,
			...(query.aggregate ? { aggregate: query.aggregate } : {}),
			limited,
			compared,
		};
	} catch (error) {
		analyticsError(error, signal);
	}
}

export function latestHeartbeatBucket(
	latest: Date | undefined,
	bucketSeconds: number | null,
) {
	if (!latest || !bucketSeconds) return null;
	const step = bucketSeconds * 1000;
	return new Date(Math.floor(latest.getTime() / step) * step);
}
