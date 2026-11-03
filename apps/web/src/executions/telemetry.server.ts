import {
	type ClickHouseClient,
	ClickHouseLogLevel,
	createClient,
} from "@clickhouse/client";
import { OperationError } from "../organizations/errors";
import type { TelemetryResult, TelemetrySeries } from "./contracts";

export interface TelemetryScope {
	projectId: string;
	sourceId: string;
	hostId: string | null;
	from: Date;
	to: Date;
	buckets: number;
}

// Time and host filtering must follow whole-batch deduplication, including conflicting retries.
const query = `
WITH logical_batches AS (
  SELECT storage_key,
    argMin(tuple(profile, points.series_id, points.host_id, points.collection_scope,
      points.metric, points.unit, points.kind, points.temporality, points.monotonic,
      points.time_ns, points.integer_value, points.double_value, points.cpu_mode),
      tuple(log_offset, record_id)) AS batch,
    throwIf(uniqExact(tuple(log_topic, log_partition)) != 1, 'Invalid batch provenance') AS invalid
  FROM batches
  WHERE project_id = {project:String} AND source_id = {source:String}
  GROUP BY storage_key
), samples AS (
  SELECT storage_key, batch.1 AS profile, id, hostId, metric, unit, time_ns, integer_value, double_value, cpuMode, ordinal,
    intDiv(time_ns - {from:UInt64}, {step:UInt64}) AS bucket
  FROM logical_batches
  ARRAY JOIN batch.2 AS id, batch.3 AS hostId, batch.4 AS collection_scope,
    batch.5 AS metric, batch.6 AS unit, batch.7 AS kind, batch.8 AS temporality,
    batch.9 AS monotonic, batch.10 AS time_ns, batch.11 AS integer_value,
    batch.12 AS double_value, batch.13 AS cpuMode, arrayEnumerate(batch.2) AS ordinal
  WHERE invalid = 0 AND batch.1 IN ('standard', 'external/1.0')
    AND time_ns >= {from:UInt64} AND time_ns < {to:UInt64}
    AND ({allHosts:UInt8} = 1 OR hostId = {host:String})
    AND collection_scope = 'node'
    AND ((metric = 'pfe.node.cpu.time' AND unit = 's' AND kind = 'sum' AND temporality = 2 AND monotonic)
      OR (metric IN ('pfe.node.memory.total', 'pfe.node.memory.available') AND unit = 'By' AND kind = 'gauge'))
    AND ((isNull(integer_value) AND (isNull(double_value) OR double_value >= 0))
      OR (isNull(double_value) AND integer_value >= 0))
)
SELECT id, profile, metric, unit, hostId, cpuMode,
  toString({from:UInt64} + bucket * {step:UInt64}) AS bucketNs,
  argMax(tuple(toString(time_ns), if(isNull(integer_value), NULL, toString(integer_value)), double_value),
    tuple(time_ns, storage_key, ordinal)) AS sample
FROM samples
GROUP BY id, profile, metric, unit, hostId, cpuMode, bucket
ORDER BY profile, id, bucket
`;

interface Row {
	id: string;
	profile: TelemetrySeries["profile"];
	metric: string;
	unit: "s" | "By";
	hostId: string | null;
	cpuMode: string | null;
	bucketNs: string;
	sample: [string, string | null, number | null];
}
let client: ClickHouseClient | undefined;
let active = 0;
export function getTelemetryClient() {
	if (client) return client;
	const url = process.env.TELEMETRY_CLICKHOUSE_URL;
	const password = process.env.TELEMETRY_CLICKHOUSE_READER_PASSWORD;
	if (!url || !password)
		throw new OperationError("UNAVAILABLE", "Analytics is not configured");
	const parsed = new URL(url);
	if (
		!["http:", "https:"].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname !== "/"
	)
		throw new OperationError("UNAVAILABLE", "Invalid analytics configuration");
	client = createClient({
		url,
		username: "telemetry_reader",
		password,
		database: "telemetry",
		request_timeout: 10000,
		max_open_connections: 2,
		log: { level: ClickHouseLogLevel.OFF },
	});
	return client;
}

export async function readTelemetry(
	scope: TelemetryScope,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<TelemetryResult> {
	const duration = scope.to.getTime() - scope.from.getTime();
	if (
		!Number.isFinite(duration) ||
		duration <= 0 ||
		duration > 86400000 ||
		scope.from.getTime() < 0 ||
		!Number.isInteger(scope.buckets) ||
		scope.buckets < 1 ||
		scope.buckets > 600
	)
		throw new OperationError(
			"INVALID_INPUT",
			"Invalid chart interval",
			"INVALID_TIME_RANGE",
		);
	if (active >= 2) throw new OperationError("CAPACITY", "Analytics is busy");
	const bucketMs = Math.max(1, Math.ceil(duration / scope.buckets));
	active++;
	try {
		const result = await (connection ?? getTelemetryClient()).query({
			query,
			format: "JSONEachRow",
			query_params: {
				project: scope.projectId,
				source: scope.sourceId,
				allHosts: scope.hostId === null ? 1 : 0,
				host: scope.hostId ?? "",
				from: (BigInt(scope.from.getTime()) * 1000000n).toString(),
				to: (BigInt(scope.to.getTime()) * 1000000n).toString(),
				step: (BigInt(bucketMs) * 1000000n).toString(),
			},
			abort_signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10000)])
				: AbortSignal.timeout(10000),
			clickhouse_settings: {
				max_execution_time: 6,
				max_threads: 1,
				max_memory_usage: "268435456",
				max_rows_to_read: "100000",
				max_bytes_to_read: "268435456",
				read_overflow_mode: "throw",
				max_result_rows: "14400",
				max_result_bytes: "4194304",
				result_overflow_mode: "throw",
				max_rows_to_group_by: "200000",
				group_by_overflow_mode: "throw",
				max_bytes_before_external_group_by: "0",
				max_bytes_before_external_sort: "0",
				output_format_json_quote_64bit_integers: 1,
			},
		});
		const rows = await result.json<Row>();
		const series = new Map<string, TelemetrySeries>();
		for (const row of rows) {
			const id = `${row.profile}:${row.id}`;
			let entry = series.get(id);
			if (!entry) {
				if (series.size >= 24)
					throw new OperationError("CAPACITY", "Too many telemetry series");
				entry = {
					id,
					profile: row.profile,
					metric: row.metric,
					unit: row.unit,
					hostId: row.hostId,
					cpuMode: row.cpuMode,
					points: [],
				};
				series.set(id, entry);
			}
			entry.points.push({
				bucketMs: Number(BigInt(row.bucketNs) / 1000000n),
				timeNs: row.sample[0],
				integer: row.sample[1],
				double: row.sample[2],
			});
		}
		return {
			from: scope.from,
			to: scope.to,
			bucketMs,
			series: [...series.values()],
		};
	} catch (error) {
		if (error instanceof OperationError) throw error;
		if (signal?.aborted)
			throw new OperationError("CANCELLED", "Analytics request cancelled");
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		if (["159", "160"].includes(code))
			throw new OperationError("TIMEOUT", "Analytics deadline exceeded");
		if (["158", "202", "241", "396"].includes(code))
			throw new OperationError("CAPACITY", "Analytics capacity exceeded");
		throw new OperationError("UNAVAILABLE", "Analytics is unavailable");
	} finally {
		active--;
	}
}
