import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import { activityNode, decodeLineage, nanosecondsDate } from "./codec.server";
import type {
	ExplorerInput,
	JsonObject,
	JsonValue,
	PointDetail,
	PointInput,
	PointPage,
	PointSummary,
} from "./contracts";

const settings = {
	max_execution_time: 6,
	max_threads: 1,
	max_memory_usage: "268435456",
	max_rows_to_read: "4000000",
	max_bytes_to_read: "536870912",
	read_overflow_mode: "throw",
	max_result_rows: "101",
	max_result_bytes: "8388608",
	result_overflow_mode: "throw",
	output_format_json_quote_64bit_integers: 1,
	output_format_json_named_tuples_as_objects: 1,
} as const;
let active = 0;
async function query<T>(
	sql: string,
	params: Record<string, string | number>,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<T[]> {
	if (active >= 2)
		throw new OperationError("CAPACITY", "Activity queries are busy");
	active++;
	try {
		const response = await connection.query({
			query: sql,
			query_params: params,
			format: "JSONEachRow",
			abort_signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10000)])
				: AbortSignal.timeout(10000),
			clickhouse_settings: settings,
		});
		return await response.json<T>();
	} catch {
		if (signal?.aborted)
			throw new OperationError("CANCELLED", "Activity query cancelled");
		throw new OperationError(
			"UNAVAILABLE",
			"Telemetry activity is unavailable",
		);
	} finally {
		active--;
	}
}
interface Row {
	sampleId: string;
	sourceId: string;
	resourceId: string;
	metricName: string;
	timeNs: string;
	hostId: string | null;
	hostname: string;
	resourceKind: number;
	kind: number;
	integer: string | null;
	double: number | null;
	count: string | null;
	unit: string;
	flags: number;
	scopeName: string;
	scopeVersion: string;
}
export const pointListQuery = `SELECT hex(sample_id) AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_nano) AS timeNs,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
resource_kind AS resourceKind,metric_kind AS kind,toString(int_value) AS integer,double_value AS double,toString(count) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM metric_points FINAL WHERE project_id={project:String} AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_nano>={from:UInt64} AND time_unix_nano<={to:UInt64}
AND ({hasCursor:UInt8}=0 OR tuple(time_unix_nano,sample_id)<tuple({cursorTime:UInt64},unhex({cursorSample:String})))
ORDER BY time_unix_nano DESC,sample_id DESC LIMIT 101`;

export async function readPoints(
	input: ExplorerInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointPage> {
	const to = input.cursor?.to ?? new Date(),
		from = input.cursor?.from ?? new Date(to.getTime() - 3600000);
	const rows = await query<Row>(
		pointListQuery,
		{
			project: input.projectId,
			firstDay: Math.floor(from.getTime() / 86400000),
			lastDay: Math.floor(to.getTime() / 86400000),
			from: (BigInt(from.getTime()) * 1000000n).toString(),
			to: (BigInt(to.getTime()) * 1000000n).toString(),
			hasCursor: input.cursor ? 1 : 0,
			cursorTime: input.cursor?.timeNs ?? "0",
			cursorSample: input.cursor?.sampleId ?? "00".repeat(32),
		},
		signal,
		connection,
	);
	const points: PointSummary[] = rows.slice(0, 100).map((row) => ({
		sampleId: row.sampleId,
		sourceId: row.sourceId,
		resourceId: row.resourceId,
		metricName: row.metricName,
		timeNs: row.timeNs,
		node: row.hostId
			? activityNode(input.projectId, row.hostId, row.hostname)
			: null,
		resourceKind: row.resourceKind,
		kind: row.kind,
		value: (row.flags & 1) !== 0 ? null : (row.integer ?? row.double),
		count: row.count,
		unit: row.unit,
		measuredAt: nanosecondsDate(row.timeNs),
		flags: row.flags,
		scopeName: row.scopeName,
		scopeVersion: row.scopeVersion,
	}));
	const last = points.at(-1);
	return {
		points,
		from,
		to,
		nextCursor:
			rows.length > 100 && last
				? { from, to, timeNs: last.timeNs, sampleId: last.sampleId }
				: null,
	};
}

export async function readPoint(
	input: PointInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointDetail> {
	const day = Number(BigInt(input.timeNs) / 86400000000000n);
	const attributes = [
		"resource_attributes",
		"scope_attributes",
		"point_attributes",
		"metric_metadata",
	];
	const projected = attributes
		.map(
			(name) =>
				`arrayMap(a -> CAST(tuple(a.path,a.kind,a.string_value,a.int_value,a.double_value,a.bool_value,base64Encode(a.bytes_value)), 'Tuple(path String,kind UInt8,string_value Nullable(String),int_value Nullable(Int64),double_value Nullable(Float64),bool_value Nullable(UInt8),bytes_value Nullable(String))'),${name}) AS ${name}_json`,
		)
		.join(",");
	const rows = await query<JsonObject>(
		`SELECT * EXCEPT(lineage,sample_id,stream_id,resource_attributes,scope_attributes,point_attributes,metric_metadata,exemplars,resource_entity_refs),
hex(sample_id) AS sample_id_hex,hex(stream_id) AS stream_id_hex,hex(lineage) AS lineage_hex,
arrayMap(value -> base64Encode(value),exemplars) AS exemplars_base64,arrayMap(value -> base64Encode(value),resource_entity_refs) AS resource_entity_refs_base64,${projected}
FROM metric_points FINAL WHERE project_id={project:String} AND source_id={source:String}
AND resource_id={resource:String} AND metric_name={metric:String} AND event_day={day:UInt32} AND time_unix_nano={time:UInt64} AND sample_id=unhex({sample:String}) LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			resource: input.resourceId,
			metric: input.metricName,
			day,
			time: input.timeNs,
			sample: input.sampleId,
		},
		signal,
		connection,
	);
	const row = rows[0];
	if (!row) throw new OperationError("NOT_FOUND", "Measurement not found");
	for (const name of attributes) {
		row[name] = row[`${name}_json`];
		delete row[`${name}_json`];
	}
	for (const name of ["sample_id", "stream_id"]) {
		row[name] = row[`${name}_hex`];
		delete row[`${name}_hex`];
	}
	for (const name of ["exemplars", "resource_entity_refs"]) {
		row[name] = row[`${name}_base64`];
		delete row[`${name}_base64`];
	}
	const select = (names: string[]) =>
		Object.fromEntries(
			names.map((key) => [key, row[key] ?? null]),
		) as JsonObject;
	const provenance = decodeLineage(String(row.lineage_hex));
	delete row.lineage_hex;
	// Binary values from ClickHouse use base64 at this JSON integration boundary.
	const raw = { ...row, lineage: provenance };
	return {
		measurement: select([
			"metric_name",
			"description",
			"metric_kind",
			"unit",
			"time_unix_nano",
			"start_time_unix_nano",
			"int_value",
			"double_value",
			"flags",
			"temporality",
			"monotonic",
			"count",
			"sum",
			"min",
			"max",
			"explicit_bounds",
			"bucket_counts",
			"scale",
			"zero_count",
			"zero_threshold",
			"positive_offset",
			"positive_counts",
			"negative_offset",
			"negative_counts",
			"quantiles",
			"quantile_values",
			"metric_metadata",
			"exemplars",
		]),
		attributes: (row.point_attributes ?? []) as JsonValue[],
		resource: select([
			"source_id",
			"resource_id",
			"resource_kind",
			"host_id",
			"device_id",
			"resource_attributes",
			"resource_schema_url",
		]),
		instrumentation: select([
			"scope_name",
			"scope_version",
			"scope_attributes",
			"scope_schema_url",
		]),
		provenance,
		raw,
	};
}
