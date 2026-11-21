import {
	type ClickHouseClient,
	ClickHouseError,
	TupleParam,
} from "@clickhouse/client";
import {
	compileFields,
	compileFilters,
	isContinuityField,
	isPointField,
} from "../analytics/compile.server";
import { executionPointSource } from "../analytics/execution-source.server";
import {
	POINT_FINAL_SETTINGS,
	seriesLastSeen,
	seriesPointSource,
	streamEvidenceSource,
} from "../analytics/series-source.server";
import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import { activityNode, decodeDelivery } from "./codec.server";
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
	...POINT_FINAL_SETTINGS,
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
// TOO_MANY_ROWS and TOO_MANY_BYTES: ClickHouse rejects a read whose granules exceed the
// caps before reading them, so a search can retry a narrower window at little cost.
const READ_LIMIT_CODES = new Set(["158", "307"]);
class ReadLimitError extends Error {}
let active = 0;
type Params = Record<string, string | number | string[] | unknown[]>;
async function query<T>(
	sql: string,
	params: Params,
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
	} catch (error) {
		if (signal?.aborted)
			throw new OperationError("CANCELLED", "Activity query cancelled");
		if (error instanceof ClickHouseError && READ_LIMIT_CODES.has(error.code))
			throw new ReadLimitError();
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
	timeMs: string;
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
interface Key {
	timeMs: string;
	sampleId: string;
	seriesId: string;
	day: number;
}

// Fixed-width hexadecimal preserves numeric series order and binary stream order.
const POINT_KEY = "concat(leftPad(hex(series_id), 16, '0'), hex(stream_id))";

function keyQuery(
	seriesFilters: string[],
	pointFilters: string[],
	execution: boolean,
	evidence: boolean,
) {
	const source = seriesPointSource(
		` AND ${seriesLastSeen("{lower:UInt64}")} AND first_seen_unix_milli <= {cursorTime:UInt64}${seriesFilters.map((condition) => ` AND ${condition}`).join("")}`,
		`AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_milli>={lower:UInt64} AND tuple(time_unix_milli,${POINT_KEY})<tuple({cursorTime:UInt64},{cursorSample:String})`,
		execution ? "s.source_id, s.resource_id, s.resource_kind" : "",
	);
	const points = evidence
		? `SELECT * FROM ${streamEvidenceSource(source)}`
		: source;
	return `SELECT toString(time_unix_milli) AS timeMs,${POINT_KEY} AS sampleId,toString(series_id) AS seriesId,event_day AS day
FROM ${execution ? executionPointSource(points) : `(${points})`}
${pointFilters.length ? `WHERE ${pointFilters.join(" AND ")}` : ""}
ORDER BY time_unix_milli DESC,sampleId DESC LIMIT {limit:UInt32}`;
}

function pointListQuery(fields: string[], evidence: boolean) {
	const projected = fields.length ? `[${fields.join(",")}] AS fields,` : "";
	const points = seriesPointSource(
		" AND series_id IN arrayMap(id -> toUInt64(id), {ids:Array(String)})",
		`AND event_day IN {days:Array(UInt32)}
AND (series_id,time_unix_milli) IN {series:Array(Tuple(UInt64,UInt64))}
AND ${POINT_KEY} IN {samples:Array(String)}`,
	);
	return `SELECT ${projected}${POINT_KEY} AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_milli) AS timeMs,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
toUInt8(resource_kind) AS resourceKind,toUInt8(metric_kind) AS kind,toString(int_value) AS integer,double_value AS double,toString(if(bitTest(statistics_present,0),count,NULL)) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM ${evidence ? streamEvidenceSource(points) : `(${points})`}
ORDER BY time_unix_milli DESC,sampleId DESC`;
}

// A page searches backwards from its cursor. Windows grow while they come back short and
// shrink when ClickHouse rejects them for the read caps, so their cost follows the
// project's data rate rather than the length of the range.
const PAGE_SIZE = 100;
const FIRST_WINDOW_MS = 300_000n;
const MIN_WINDOW_MS = 1_000n;
const MAX_SEARCHES = 12;
const SEARCH_BUDGET_MS = 4000;
const MS_PER_DAY = 86_400_000n;
const AFTER_ALL = "FF".repeat(24),
	BEFORE_ALL = "00".repeat(24);

function summary(projectId: string, row: Row, fields: string[]): PointSummary {
	return {
		sampleId: row.sampleId,
		sourceId: row.sourceId,
		resourceId: row.resourceId,
		metricName: row.metricName,
		timeMs: row.timeMs,
		node: row.hostId ? activityNode(projectId, row.hostId, row.hostname) : null,
		resourceKind: row.resourceKind,
		kind: row.kind,
		value: (row.flags & 1) === 0 ? (row.integer ?? row.double) : null,
		count: row.count,
		unit: row.unit,
		measuredAt: new Date(Number(row.timeMs)),
		flags: row.flags,
		scopeName: row.scopeName,
		scopeVersion: row.scopeVersion,
		fields: Object.fromEntries(
			fields.map((field, index) => [field, row.fields?.[index] ?? null]),
		),
	};
}

interface Search {
	keys: Key[];
	cursorMs: bigint;
	cursorSample: string;
	exhausted: boolean;
}

/** Finds the keys of the newest points before the cursor, one more than a page. */
async function searchKeys(
	sql: string,
	params: Params,
	fromMs: bigint,
	cursorMs: bigint,
	cursorSample: string,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<Search> {
	const keys: Key[] = [],
		started = Date.now();
	let span = FIRST_WINDOW_MS;
	for (let search = 0; search < MAX_SEARCHES; search++) {
		const lower = cursorMs - span > fromMs ? cursorMs - span : fromMs;
		const limit = PAGE_SIZE + 1 - keys.length;
		let batch: Key[];
		try {
			batch = await query<Key>(
				sql,
				{
					...params,
					firstDay: Number(lower / MS_PER_DAY),
					lastDay: Number(cursorMs / MS_PER_DAY),
					lower: lower.toString(),
					cursorTime: cursorMs.toString(),
					cursorSample,
					limit,
				},
				signal,
				connection,
			);
		} catch (error) {
			if (!(error instanceof ReadLimitError)) throw error;
			if (span <= MIN_WINDOW_MS)
				throw new OperationError("CAPACITY", "Activity range is too dense");
			span /= 4n;
			continue;
		}
		for (const key of batch) {
			const previous = keys.at(-1);
			if (previous?.timeMs !== key.timeMs || previous.sampleId !== key.sampleId)
				keys.push(key);
		}
		if (batch.length === limit) {
			// The window holds more points: continue below the last key in it.
			const last = batch.at(-1) as Key;
			cursorMs = BigInt(last.timeMs);
			cursorSample = last.sampleId;
		} else {
			// Points at the window's lower bound were included, so the next window excludes them.
			cursorMs = lower;
			cursorSample = BEFORE_ALL;
			if (lower <= fromMs)
				return { keys, cursorMs, cursorSample, exhausted: true };
			span *= 4n;
		}
		if (keys.length > PAGE_SIZE || Date.now() - started > SEARCH_BUDGET_MS)
			break;
	}
	return { keys, cursorMs, cursorSample, exhausted: false };
}

export async function readPoints(
	input: ExplorerInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointPage> {
	const to = input.cursor?.to ?? input.to ?? new Date(),
		from = input.cursor?.from ?? input.from ?? new Date(to.getTime() - 3600000);
	const filters = compileFilters(input.filters ?? []);
	const fieldsInFilters = (input.filters ?? []).map((filter) => filter.field);
	const conditions = filters.conditions.filter(
		(_, i) => !isPointField(fieldsInFilters[i]),
	);
	const pointConditions = filters.conditions.filter((_, i) =>
		isPointField(fieldsInFilters[i]),
	);
	if (input.metric !== undefined)
		conditions.push("metric_name={metric:String}");
	const fields = input.fields ?? [];
	const projections = compileFields(fields);
	const params = {
		...filters.params,
		...(input.metric === undefined ? {} : { metric: input.metric }),
		project: input.projectId,
		from: BigInt(from.getTime()).toString(),
		to: BigInt(to.getTime()).toString(),
	};
	const fromMs = BigInt(from.getTime());
	const search = await searchKeys(
		keyQuery(
			conditions,
			pointConditions,
			fieldsInFilters.includes("execution"),
			fieldsInFilters.some(isContinuityField),
		),
		params,
		fromMs,
		input.cursor ? BigInt(input.cursor.timeMs) : BigInt(to.getTime()),
		input.cursor?.sampleId ?? AFTER_ALL,
		signal,
		connection,
	);
	const keys = search.keys.slice(0, PAGE_SIZE);
	const rows = keys.length
		? await query<Row>(
				pointListQuery(projections.expressions, fields.some(isContinuityField)),
				{
					...projections.params,
					project: input.projectId,
					days: [...new Set(keys.map((key) => key.day))],
					ids: [...new Set(keys.map((key) => key.seriesId))],
					series: keys.map(
						(key) => new TupleParam([BigInt(key.seriesId), BigInt(key.timeMs)]),
					),
					samples: keys.map((key) => key.sampleId),
				},
				signal,
				connection,
			)
		: [];
	const points = rows.map((row) => summary(input.projectId, row, fields));
	// A full page resumes after its last key; otherwise the search resumes where it
	// stopped, until the range is exhausted.
	let nextCursor: PointPage["nextCursor"] = search.exhausted
		? null
		: {
				from,
				to,
				timeMs: search.cursorMs.toString(),
				sampleId: search.cursorSample,
			};
	const last = keys.at(-1);
	if (search.keys.length > PAGE_SIZE && last)
		nextCursor = { from, to, timeMs: last.timeMs, sampleId: last.sampleId };
	return {
		points,
		from,
		to,
		searchedTo: new Date(Number(nextCursor?.timeMs ?? fromMs)),
		nextCursor,
	};
}

export async function readPoint(
	input: PointInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointDetail> {
	const day = Number(BigInt(input.timeMs) / 86_400_000n);
	const attributes = [
		"resource_attributes",
		"scope_attributes",
		"point_attributes",
		"metric_metadata",
	];
	const projected = attributes
		.map(
			(name) =>
				`arrayMap(a -> CAST(tuple(a.path,a.kind,a.string_value,a.int_value,a.double_value,a.bool_value,base64Encode(a.bytes_value)), 'Tuple(path String,kind UInt8,string_value Nullable(String),int_value Nullable(Int64),double_value Nullable(Float64),bool_value Nullable(UInt8),bytes_value Nullable(String))'),${inspectorAttributes(name)}) AS ${name}_json`,
		)
		.join(",");
	const rows = await query<JsonObject>(
		`SELECT * EXCEPT(stream_id,resource_attributes,scope_attributes,point_attributes,metric_metadata,exemplars,resource_entity_refs,resource_continuity,point_continuity,first_seen_unix_milli,last_seen_unix_milli,logical_series_id,resource_kind,metric_kind,temporality,monotonic,value_kind,statistics_present)
REPLACE (${["count", "sum", "min", "max", "scale", "zero_count", "zero_threshold", "positive_offset", "negative_offset"].map((name, i) => `if(bitTest(statistics_present,${i}),${name},NULL) AS ${name}`).join(",")}),
toUInt8(resource_kind) AS resource_kind,toUInt8(metric_kind) AS metric_kind,toUInt8(temporality) AS temporality,
nullIf(toUInt8(monotonic),2) AS monotonic,
hex(stream_id) AS stream_id_hex,
arrayMap(value -> base64Encode(value),exemplars) AS exemplars_base64,arrayMap(value -> base64Encode(value),resource_entity_refs) AS resource_entity_refs_base64,${projected}
FROM ${streamEvidenceSource(
			seriesPointSource(
				` AND source_id={source:String} AND resource_id={resource:String} AND metric_name={metric:String} AND first_seen_unix_milli <= {time:UInt64} AND ${seriesLastSeen("{time:UInt64}")}`,
				`AND event_day={day:UInt32} AND time_unix_milli={time:UInt64} AND series_id={series:UInt64} AND stream_id=unhex({stream:String})`,
				undefined,
				"AND metric_name={metric:String}",
			),
			" AND stream_id=unhex({stream:String})",
		)} LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			resource: input.resourceId,
			metric: input.metricName,
			day,
			time: input.timeMs,
			series: BigInt(`0x${input.sampleId.slice(0, 16)}`).toString(),
			stream: input.sampleId.slice(16),
		},
		signal,
		connection,
	);
	const row = rows[0];
	if (!row) throw new OperationError("NOT_FOUND", "Measurement not found");
	if (Number(row.evidence_present) !== 1)
		throw new OperationError(
			"UNAVAILABLE",
			"Measurement continuity is not yet available",
		);
	delete row.evidence_present;
	for (const name of attributes) {
		row[name] = row[`${name}_json`];
		delete row[`${name}_json`];
	}
	for (const name of ["stream_id"]) {
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
	const [delivery] = await query<{
		request: string;
		context: string;
		received: string;
		oldest: string;
		newest: string;
	}>(
		`SELECT hex(d.delivery_request) AS request, hex(c.delivery_context) AS context, toString(received_unix_nano) AS received,
		  toString(min_event_unix_milli) AS oldest, toString(max_event_unix_milli) AS newest
		FROM (SELECT * FROM deliveries FINAL WHERE project_id={project:String} AND source_id={source:String}
		  AND raw_partition={partition:UInt32} AND raw_offset={offset:UInt64}) d
		INNER JOIN (SELECT delivery_context_id, delivery_context FROM delivery_contexts FINAL
		  WHERE project_id={project:String} AND source_id={source:String}) c USING (delivery_context_id)
		LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			partition: Number(row.raw_partition),
			offset: String(row.raw_offset),
		},
		signal,
		connection,
	);
	if (!delivery)
		throw new OperationError(
			"UNAVAILABLE",
			"Measurement provenance is not yet available",
		);
	const received = BigInt(delivery.received);
	const {
		original_resource,
		original_scope,
		original_metric,
		original_point,
		...point
	} = row;
	const provenance = {
		...decodeDelivery(delivery.request, delivery.context, {
			resource: Number(original_resource),
			scope: Number(original_scope),
			metric: Number(original_metric),
			point: Number(original_point),
		}),
		raw_partition: row.raw_partition,
		raw_offset: String(row.raw_offset),
		received_unix_nano: delivery.received,
		min_event_unix_milli: delivery.oldest,
		max_event_unix_milli: delivery.newest,
		oldest_collection_delay_ns: String(
			received - BigInt(delivery.oldest) * 1_000_000n,
		),
		newest_collection_delay_ns: String(
			received - BigInt(delivery.newest) * 1_000_000n,
		),
	};
	// Binary values from ClickHouse use base64 at this JSON integration boundary.
	const raw = { ...point, lineage: provenance };
	return {
		measurement: select([
			"metric_name",
			"description",
			"metric_kind",
			"unit",
			"time_unix_milli",
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

function inspectorAttributes(name: string) {
	if (name !== "resource_attributes" && name !== "point_attributes")
		return name;
	const markers =
		name === "resource_attributes" ? "resource_continuity" : "point_continuity";
	return `arraySort(a -> a.path, arrayConcat(${name}, arrayMap(c -> c.node, ${markers})))`;
}
