import {
	type ClickHouseClient,
	ClickHouseLogLevel,
	createClient,
} from "@clickhouse/client";
import { OperationError } from "../organizations/errors";
import type {
	TelemetryPoint,
	TelemetryResult,
	TelemetrySeries,
} from "./contracts";

export interface TelemetryScope {
	projectId: string;
	sourceId: string;
	hostId: string | null;
	from: Date;
	to: Date;
	buckets: number;
}

// Attribute paths retain array indexes and container kinds. Sorting canonicalizes
// maps without conflating integers, bytes, absent values or Float64 bit patterns.
function dimensions(column: string, excluded: string[] = []) {
	const nodes = excluded.length
		? `arrayFilter(a -> a.path NOT IN (${excluded.map((p) => `'${p}'`).join(",")}), ${column})`
		: column;
	return `arraySort(a -> a.1, arrayMap(a -> tuple(a.path,a.kind,a.string_value,a.int_value,
    if(isNull(a.double_value),NULL,reinterpretAsUInt64(assumeNotNull(a.double_value))),
    a.bool_value,a.bytes_value), ${nodes}))`;
}

// FINAL establishes sample uniqueness before bucket selection, independently of
// background merges. Only supported node scalars and their dimensions are read.
export const telemetryQuery = `
WITH samples AS (
  SELECT hex(SHA256(toString(tuple(project_id,source_id,resource_id,resource_kind,host_id,device_id,
    resource_present,scope_present,scope_name,scope_version,resource_schema_url,scope_schema_url,
    metric_name,unit,metric_kind,temporality,monotonic,
    ${dimensions("resource_attributes", ["/recount.host.boot_id", "/recount.collection.epoch_id"])},
    ${dimensions("scope_attributes")},
    ${dimensions("point_attributes", ["/recount.counter.segment_id"])})))) AS id,
    hex(stream_id) AS segment, metric_name AS metric, unit, host_id AS hostId,
    arrayFirst(a -> a.path='/cpu.mode' AND a.kind=2,point_attributes).string_value AS cpuMode,
    time_unix_nano, sample_id, flags,
    if(bitAnd(flags,1)=0,int_value,NULL) AS integer_value,
    if(bitAnd(flags,1)=0,double_value,NULL) AS scalar_double,
    intDiv(time_unix_nano-{from:UInt64},{step:UInt64}) AS bucket
  FROM metric_points FINAL
  WHERE project_id={project:String} AND source_id={source:String}
    AND event_day >= {firstDay:UInt32} AND event_day <= {lastDay:UInt32}
    AND time_unix_nano >= {from:UInt64} AND time_unix_nano < {to:UInt64}
    AND ({allHosts:UInt8}=1 OR host_id={host:String})
    AND resource_kind=1
    AND arrayExists(a -> a.path='/recount.collection.scope' AND a.kind=2 AND a.string_value='node',resource_attributes)
    AND ((metric_name='recount.node.cpu.time' AND unit='s' AND metric_kind=2 AND temporality=2 AND monotonic=1)
      OR (metric_name IN ('recount.node.memory.total','recount.node.memory.available') AND unit='By' AND metric_kind=1))
    AND (bitAnd(flags,1)!=0 OR (isNull(int_value) AND double_value>=0)
      OR (isNull(double_value) AND int_value>=0))
)
SELECT id,segment,metric,unit,hostId,cpuMode,
  toString({from:UInt64}+bucket*{step:UInt64}) AS bucketNs,
  argMax(tuple(toString(time_unix_nano),if(isNull(integer_value),NULL,toString(integer_value)),scalar_double,flags),
    tuple(time_unix_nano,sample_id)) AS sample
FROM samples GROUP BY id,segment,metric,unit,hostId,cpuMode,bucket
`;

interface Row {
	id: string;
	segment: string;
	metric: string;
	unit: "s" | "By";
	hostId: string | null;
	cpuMode: string | null;
	bucketNs: string;
	sample: [string, string | null, number | null, number];
}
let client: ClickHouseClient | undefined;
let active = 0;
export function getTelemetryClient() {
	if (client) return client;
	const url = process.env.RECOUNT_CLICKHOUSE_URL,
		password = process.env.RECOUNT_CLICKHOUSE_READER_PASSWORD;
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

export async function closeTelemetryClient() {
	const current = client;
	client = undefined;
	await current?.close();
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
	if (signal?.aborted)
		throw new OperationError("CANCELLED", "Analytics request cancelled");
	if (active >= 2) throw new OperationError("CAPACITY", "Analytics is busy");
	const bucketMs = Math.max(1, Math.ceil(duration / scope.buckets));
	active++;
	try {
		const result = await (connection ?? getTelemetryClient()).query({
			query: telemetryQuery,
			format: "JSONEachRow",
			query_params: {
				project: scope.projectId,
				source: scope.sourceId,
				allHosts: scope.hostId === null ? 1 : 0,
				host: scope.hostId ?? "",
				from: (BigInt(scope.from.getTime()) * 1000000n).toString(),
				to: (BigInt(scope.to.getTime()) * 1000000n).toString(),
				step: (BigInt(bucketMs) * 1000000n).toString(),
				firstDay: Math.floor(scope.from.getTime() / 86400000),
				lastDay: Math.floor((scope.to.getTime() - 1) / 86400000),
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
				max_result_rows: "50000",
				max_result_bytes: "8388608",
				result_overflow_mode: "throw",
				max_rows_to_group_by: "200000",
				group_by_overflow_mode: "throw",
				max_bytes_before_external_group_by: "0",
				max_bytes_before_external_sort: "0",
				output_format_json_quote_64bit_integers: 1,
			},
		});
		const rows = await result.json<Row>();
		if (signal?.aborted)
			throw new OperationError("CANCELLED", "Analytics request cancelled");
		const series = new Map<string, TelemetrySeries>();
		const segments = new Map<string, TelemetryPoint[]>();
		for (const row of rows) {
			const segmentId = `${row.id}/${row.segment}`;
			let entry = series.get(row.id);
			if (!entry) {
				if (series.size >= 24)
					throw new OperationError(
						"CAPACITY",
						"Too many logical telemetry groups",
					);
				entry = {
					id: row.id,
					metric: row.metric,
					unit: row.unit,
					hostId: row.hostId,
					cpuMode: row.cpuMode,
					segments: [],
				};
				series.set(row.id, entry);
			}
			let points = segments.get(segmentId);
			if (!points) {
				if (segments.size >= 256)
					throw new OperationError("CAPACITY", "Too many continuity segments");
				points = [];
				segments.set(segmentId, points);
				entry.segments.push({ id: row.segment, points });
			}
			points.push({
				bucketMs: Number(BigInt(row.bucketNs) / 1000000n),
				timeNs: row.sample[0],
				integer: row.sample[1],
				double: row.sample[2],
				flags: row.sample[3],
			});
		}
		for (const entry of series.values()) {
			entry.segments.sort((a, b) => a.id.localeCompare(b.id));
			for (const segment of entry.segments)
				segment.points.sort((a, b) => a.bucketMs - b.bucketMs);
		}
		return {
			from: scope.from,
			to: scope.to,
			bucketMs,
			series: [...series.values()].sort((a, b) => a.id.localeCompare(b.id)),
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
		if (["158", "202", "241", "252", "307", "396"].includes(code))
			throw new OperationError("CAPACITY", "Analytics capacity exceeded");
		throw new OperationError("UNAVAILABLE", "Analytics is unavailable");
	} finally {
		active--;
	}
}
