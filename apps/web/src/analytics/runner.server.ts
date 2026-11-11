import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { compileMeasure } from "./compile.server";
import {
	type AnalyticsQuery,
	INTERVALS,
	MAX_SERIES,
	type QueryResult,
	type SeriesResult,
} from "./contracts";
import { metricDefinition } from "./discovery.server";
import { ALLOWED_CALCULATIONS, resolveRange } from "./validation";

// Analyses may read more rows than the point reader, but time, memory and threads stay
// within the telemetry_read profile's constraints, which ClickHouse enforces anyway.
const SETTINGS = {
	max_execution_time: 6,
	max_threads: 1,
	max_memory_usage: "268435456",
	max_rows_to_read: "20000000",
	max_bytes_to_read: "2147483648",
	read_overflow_mode: "throw",
	max_result_rows: "50000",
	max_result_bytes: "8388608",
	result_overflow_mode: "throw",
	max_rows_to_group_by: "2000000",
	group_by_overflow_mode: "throw",
	max_bytes_before_external_group_by: "0",
	max_bytes_before_external_sort: "0",
	output_format_json_quote_64bit_integers: 1,
} as const;
const MAX_CONCURRENT = 2;
let active = 0;

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

/** Runs a validated query for an already authorized project. */
export async function runQuery(
	projectId: string,
	query: AnalyticsQuery,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<QueryResult> {
	if (signal?.aborted)
		throw new OperationError("CANCELLED", "Analytics request cancelled");
	if (active >= MAX_CONCURRENT)
		throw new OperationError("CAPACITY", "Analytics is busy");
	const { from, to } = resolveRange(query.range);
	const deadline = AbortSignal.timeout(10_000);
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
	active++;
	try {
		const measures: QueryResult["measures"] = [];
		const series: SeriesResult[] = [];
		let limited = false;
		for (const measure of query.measures) {
			const definition = await metricDefinition(
				connection,
				projectId,
				measure.metric,
				abort,
			);
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
			const compiled = compileMeasure(query, measure, {
				projectId,
				from,
				to,
				kind: definition.kind,
				behavior: definition.behavior,
			});
			const result = await connection.query({
				query: compiled.sql,
				format: "JSONEachRow",
				query_params: compiled.params,
				abort_signal: abort,
				clickhouse_settings: SETTINGS,
			});
			const rows = await result.json<Record<string, string | number | null>>();
			const groups = new Map<string, SeriesResult>();
			for (const row of rows) {
				if (Number(row.rank) > MAX_SERIES) {
					limited = true;
					continue;
				}
				const group = compiled.groupColumns.map((column) =>
					row[column] === null ? null : String(row[column]),
				);
				const key = JSON.stringify(group);
				let entry = groups.get(key);
				if (!entry) {
					entry = { measure: measure.name, group, points: [] };
					groups.set(key, entry);
				}
				entry.points.push({
					bucketMs:
						query.shape === "timeseries"
							? Number(BigInt(String(row.bucket)) / 1_000_000n)
							: null,
					value: row.value === null ? null : Number(row.value),
				});
			}
			series.push(...groups.values());
			measures.push({
				name: measure.name,
				metric: measure.metric,
				unit: definition.unit,
				calculation: measure.calculation,
			});
		}
		return {
			shape: query.shape,
			from,
			to,
			bucketSeconds:
				query.shape === "timeseries" && query.interval
					? INTERVALS[query.interval]
					: null,
			groupBy: query.groupBy ?? [],
			measures,
			series,
			limited,
		};
	} catch (error) {
		analyticsError(error, signal);
	} finally {
		active--;
	}
}
