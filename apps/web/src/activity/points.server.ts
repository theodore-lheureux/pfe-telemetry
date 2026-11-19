import {
	type ClickHouseClient,
	ClickHouseError,
	TupleParam,
} from "@clickhouse/client";
import {
	compileFields,
	compileFilters,
	isPointField,
} from "../analytics/compile.server";
import { executionPointSource } from "../analytics/execution-source.server";
import {
	POINT_FINAL_SETTINGS,
	seriesPointSource,
} from "../analytics/series-source.server";
import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import { activityNode, decodeDelivery, nanosecondsDate } from "./codec.server";
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
interface Key {
	timeNs: string;
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
) {
	const points = seriesPointSource(
		` AND last_seen_unix_nano >= {lower:UInt64} AND first_seen_unix_nano <= {cursorTime:UInt64}${seriesFilters.map((condition) => ` AND ${condition}`).join("")}`,
		`AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_nano>={lower:UInt64} AND tuple(time_unix_nano,${POINT_KEY})<tuple({cursorTime:UInt64},{cursorSample:String})`,
		execution ? "s.source_id, s.resource_id, s.resource_kind" : "",
	);
	return `SELECT toString(time_unix_nano) AS timeNs,${POINT_KEY} AS sampleId,toString(series_id) AS seriesId,event_day AS day
FROM ${execution ? executionPointSource(points) : `(${points})`}
${pointFilters.length ? `WHERE ${pointFilters.join(" AND ")}` : ""}
ORDER BY time_unix_nano DESC,sampleId DESC LIMIT {limit:UInt32}`;
}

function pointListQuery(fields: string[]) {
	const projected = fields.length ? `[${fields.join(",")}] AS fields,` : "";
	const points = seriesPointSource(
		" AND series_id IN arrayMap(id -> toUInt64(id), {ids:Array(String)})",
		`AND event_day IN {days:Array(UInt32)}
AND (series_id,time_unix_nano) IN {series:Array(Tuple(UInt64,UInt64))}
AND ${POINT_KEY} IN {samples:Array(String)}`,
	);
	return `SELECT ${projected}${POINT_KEY} AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_nano) AS timeNs,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
toUInt8(resource_kind) AS resourceKind,toUInt8(metric_kind) AS kind,toString(int_value) AS integer,double_value AS double,toString(if(bitTest(statistics_present,0),count,NULL)) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM (${points})
ORDER BY time_unix_nano DESC,sampleId DESC`;
}

// A page searches backwards from its cursor. Windows grow while they come back short and
// shrink when ClickHouse rejects them for the read caps, so their cost follows the
// project's data rate rather than the length of the range.
const PAGE_SIZE = 100;
const FIRST_WINDOW_NS = 300_000_000_000n;
const MIN_WINDOW_NS = 1_000_000_000n;
const MAX_SEARCHES = 12;
const SEARCH_BUDGET_MS = 4000;
const NS_PER_MS = 1000000n;
const NS_PER_DAY = 86400000000000n;
const AFTER_ALL = "FF".repeat(40),
	BEFORE_ALL = "00".repeat(40);

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
		value: (row.flags & 1) === 0 ? (row.integer ?? row.double) : null,
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

interface Search {
	keys: Key[];
	cursorNs: bigint;
	cursorSample: string;
	exhausted: boolean;
}

/** Finds the keys of the newest points before the cursor, one more than a page. */
async function searchKeys(
	sql: string,
	params: Params,
	fromNs: bigint,
	cursorNs: bigint,
	cursorSample: string,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<Search> {
	const keys: Key[] = [],
		started = Date.now();
	let span = FIRST_WINDOW_NS;
	for (let search = 0; search < MAX_SEARCHES; search++) {
		const lower = cursorNs - span > fromNs ? cursorNs - span : fromNs;
		const limit = PAGE_SIZE + 1 - keys.length;
		let batch: Key[];
		try {
			batch = await query<Key>(
				sql,
				{
					...params,
					firstDay: Number(lower / NS_PER_DAY),
					lastDay: Number(cursorNs / NS_PER_DAY),
					lower: lower.toString(),
					cursorTime: cursorNs.toString(),
					cursorSample,
					limit,
				},
				signal,
				connection,
			);
		} catch (error) {
			if (!(error instanceof ReadLimitError)) throw error;
			if (span <= MIN_WINDOW_NS)
				throw new OperationError("CAPACITY", "Activity range is too dense");
			span /= 4n;
			continue;
		}
		for (const key of batch) {
			const previous = keys.at(-1);
			if (previous?.timeNs !== key.timeNs || previous.sampleId !== key.sampleId)
				keys.push(key);
		}
		if (batch.length === limit) {
			// The window holds more points: continue below the last key in it.
			const last = batch.at(-1) as Key;
			cursorNs = BigInt(last.timeNs);
			cursorSample = last.sampleId;
		} else {
			// Points at the window's lower bound were included, so the next window excludes them.
			cursorNs = lower;
			cursorSample = BEFORE_ALL;
			if (lower <= fromNs)
				return { keys, cursorNs, cursorSample, exhausted: true };
			span *= 4n;
		}
		if (keys.length > PAGE_SIZE || Date.now() - started > SEARCH_BUDGET_MS)
			break;
	}
	return { keys, cursorNs, cursorSample, exhausted: false };
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
		from: (BigInt(from.getTime()) * NS_PER_MS).toString(),
		to: (BigInt(to.getTime()) * NS_PER_MS).toString(),
	};
	const fromNs = BigInt(from.getTime()) * NS_PER_MS;
	const search = await searchKeys(
		keyQuery(
			conditions,
			pointConditions,
			fieldsInFilters.includes("execution"),
		),
		params,
		fromNs,
		input.cursor
			? BigInt(input.cursor.timeNs)
			: BigInt(to.getTime()) * NS_PER_MS,
		input.cursor?.sampleId ?? AFTER_ALL,
		signal,
		connection,
	);
	const keys = search.keys.slice(0, PAGE_SIZE);
	const rows = keys.length
		? await query<Row>(
				pointListQuery(projections.expressions),
				{
					...projections.params,
					project: input.projectId,
					days: [...new Set(keys.map((key) => key.day))],
					ids: [...new Set(keys.map((key) => key.seriesId))],
					series: keys.map(
						(key) => new TupleParam([BigInt(key.seriesId), BigInt(key.timeNs)]),
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
				timeNs: search.cursorNs.toString(),
				sampleId: search.cursorSample,
			};
	const last = keys.at(-1);
	if (search.keys.length > PAGE_SIZE && last)
		nextCursor = { from, to, timeNs: last.timeNs, sampleId: last.sampleId };
	return {
		points,
		from,
		to,
		searchedTo: nanosecondsDate(nextCursor?.timeNs ?? fromNs.toString()),
		nextCursor,
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
				`arrayMap(a -> CAST(tuple(a.path,a.kind,a.string_value,a.int_value,a.double_value,a.bool_value,base64Encode(a.bytes_value)), 'Tuple(path String,kind UInt8,string_value Nullable(String),int_value Nullable(Int64),double_value Nullable(Float64),bool_value Nullable(UInt8),bytes_value Nullable(String))'),${inspectorAttributes(name)}) AS ${name}_json`,
		)
		.join(",");
	const rows = await query<JsonObject>(
		`SELECT * EXCEPT(original_position,stream_id,resource_attributes,scope_attributes,point_attributes,metric_metadata,exemplars,resource_entity_refs,resource_continuity,point_continuity,first_seen_unix_nano,last_seen_unix_nano,logical_series_id,resource_kind,metric_kind,temporality,monotonic,value_kind,statistics_present)
REPLACE (${["count", "sum", "min", "max", "scale", "zero_count", "zero_threshold", "positive_offset", "negative_offset"].map((name, i) => `if(bitTest(statistics_present,${i}),${name},NULL) AS ${name}`).join(",")}),
toUInt8(resource_kind) AS resource_kind,toUInt8(metric_kind) AS metric_kind,toUInt8(temporality) AS temporality,
nullIf(toUInt8(monotonic),2) AS monotonic,
hex(stream_id) AS stream_id_hex,hex(original_position) AS original_hex,
arrayMap(value -> base64Encode(value),exemplars) AS exemplars_base64,arrayMap(value -> base64Encode(value),resource_entity_refs) AS resource_entity_refs_base64,${projected}
FROM (${seriesPointSource(
			" AND source_id={source:String} AND resource_id={resource:String} AND metric_name={metric:String} AND first_seen_unix_nano <= {time:UInt64} AND last_seen_unix_nano >= {time:UInt64}",
			`AND event_day={day:UInt32} AND time_unix_nano={time:UInt64} AND series_id={series:UInt64} AND stream_id=unhex({stream:String})`,
			undefined,
			"AND metric_name={metric:String}",
		)}) LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			resource: input.resourceId,
			metric: input.metricName,
			day,
			time: input.timeNs,
			series: BigInt(`0x${input.sampleId.slice(0, 16)}`).toString(),
			stream: input.sampleId.slice(16),
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
	const [delivery] = await query<{ evidence: string }>(
		`SELECT hex(delivery_evidence) AS evidence FROM deliveries FINAL
		WHERE project_id={project:String} AND source_id={source:String}
		  AND received_unix_nano={received:UInt64} AND receipt_tag={tag:UInt32} LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			received: String(row.received_unix_nano),
			tag: Number(row.receipt_tag),
		},
		signal,
		connection,
	);
	if (!delivery)
		throw new OperationError(
			"UNAVAILABLE",
			"Measurement provenance is not yet available",
		);
	const provenance = decodeDelivery(
		delivery.evidence,
		String(row.original_hex),
	);
	delete row.receipt_tag;
	delete row.original_hex;
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
	// Insert in ascending original ordinal, restoring the source's depth-first order.
	return `arrayFold((attrs, c) -> arrayConcat(arraySlice(attrs, 1, c.ordinal), [c.node],
		arraySlice(attrs, c.ordinal + 1)), ${markers}, ${name})`;
}
