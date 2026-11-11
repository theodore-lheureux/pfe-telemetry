import type { ClickHouseClient } from "@clickhouse/client";
import { compileFields, compileFilters } from "../analytics/compile.server";
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
	params: Record<string, string | number | string[]>,
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
	fields?: (string | null)[];
}
function pointListQuery(conditions: string[], fields: string[]) {
	const projected = fields.length ? `[${fields.join(",")}] AS fields,` : "";
	return `SELECT ${projected}hex(sample_id) AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_nano) AS timeNs,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
resource_kind AS resourceKind,metric_kind AS kind,toString(int_value) AS integer,double_value AS double,toString(count) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM metric_points FINAL WHERE project_id={project:String} AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_nano>={from:UInt64} AND time_unix_nano<={to:UInt64}
AND tuple(time_unix_nano,sample_id)<tuple({cursorTime:UInt64},unhex({cursorSample:String}))${conditions.map((condition) => `\nAND ${condition}`).join("")}
ORDER BY time_unix_nano DESC,sample_id DESC LIMIT 101`;
}

// Newest-first reads cannot use the table's sort order, so a page searches backwards in
// windows that stay within the row limits and stops once it has a full page.
const WINDOWS_MS = [900_000, 3_600_000, 21_600_000];
const MAX_WINDOWS = 6;
const WINDOW_BUDGET_MS = 4000;
const NS_PER_MS = 1000000n;
const AFTER_ALL = "FF".repeat(32),
	BEFORE_ALL = "00".repeat(32);

function summary(projectId: string, row: Row, fields: string[]): PointSummary {
	return {
		sampleId: row.sampleId,
		sourceId: row.sourceId,
		resourceId: row.resourceId,
		metricName: row.metricName,
		timeNs: row.timeNs,
		node: row.hostId ? activityNode(projectId, row.hostId, row.hostname) : null,
		resourceKind: row.resourceKind,
		kind: row.kind,
		value: (row.flags & 1) !== 0 ? null : (row.integer ?? row.double),
		count: row.count,
		unit: row.unit,
		measuredAt: nanosecondsDate(row.timeNs),
		flags: row.flags,
		scopeName: row.scopeName,
		scopeVersion: row.scopeVersion,
		fields: Object.fromEntries(
			fields.map((field, index) => [field, row.fields?.[index] ?? null]),
		),
	};
}

export async function readPoints(
	input: ExplorerInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointPage> {
	const to = input.cursor?.to ?? input.to ?? new Date(),
		from = input.cursor?.from ?? input.from ?? new Date(to.getTime() - 3600000);
	const filters = compileFilters(input.filters ?? []);
	const conditions = [...filters.conditions];
	if (input.metric !== undefined)
		conditions.push("metric_name={metric:String}");
	const fields = input.fields ?? [];
	const projections = compileFields(fields);
	const sql = pointListQuery(conditions, projections.expressions);
	const fromNs = BigInt(from.getTime()) * NS_PER_MS;
	let upperNs = input.cursor
			? BigInt(input.cursor.timeNs)
			: BigInt(to.getTime()) * NS_PER_MS,
		upperSample = input.cursor?.sampleId ?? AFTER_ALL,
		lowerNs = upperNs;
	const rows: Row[] = [],
		started = Date.now();
	for (let window = 0; window < MAX_WINDOWS && rows.length <= 100; window++) {
		const span =
			BigInt(WINDOWS_MS[Math.min(window, WINDOWS_MS.length - 1)] ?? 0) *
			NS_PER_MS;
		lowerNs = upperNs - span > fromNs ? upperNs - span : fromNs;
		rows.push(
			...(await query<Row>(
				sql,
				{
					...filters.params,
					...projections.params,
					...(input.metric === undefined ? {} : { metric: input.metric }),
					project: input.projectId,
					firstDay: Number(lowerNs / 86400000000000n),
					lastDay: Number(upperNs / 86400000000000n),
					from: lowerNs.toString(),
					to: upperNs.toString(),
					cursorTime: upperNs.toString(),
					cursorSample: upperSample,
				},
				signal,
				connection,
			)),
		);
		if (lowerNs <= fromNs || Date.now() - started > WINDOW_BUDGET_MS) break;
		// Rows at the window's lower bound were included, so the next window excludes them.
		upperNs = lowerNs;
		upperSample = BEFORE_ALL;
	}
	const points = rows
		.slice(0, 100)
		.map((row) => summary(input.projectId, row, fields));
	const last = points.at(-1);
	const exhausted = rows.length <= 100 && lowerNs <= fromNs;
	return {
		points,
		from,
		to,
		searchedTo: nanosecondsDate(lowerNs.toString()),
		nextCursor:
			rows.length > 100 && last
				? { from, to, timeNs: last.timeNs, sampleId: last.sampleId }
				: exhausted
					? null
					: {
							from,
							to,
							timeNs: lowerNs.toString(),
							sampleId: BEFORE_ALL,
						},
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
