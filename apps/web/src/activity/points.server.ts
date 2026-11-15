import {
	type ClickHouseClient,
	ClickHouseError,
	TupleParam,
} from "@clickhouse/client";
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
	sourceId: string;
	resourceId: string;
	metricName: string;
	day: number;
}

// Points are sorted by series, so the newest points of a window are found by sorting
// only their narrow key columns. Without FINAL, a resent point can appear more than once
// until merges remove its copies.
function keyQuery(conditions: string[]) {
	return `SELECT toString(time_unix_nano) AS timeNs,hex(sample_id) AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,event_day AS day
FROM metric_points WHERE project_id={project:String} AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_nano>={lower:UInt64} AND tuple(time_unix_nano,sample_id)<tuple({cursorTime:UInt64},unhex({cursorSample:String}))${conditions.map((condition) => `\nAND ${condition}`).join("")}
ORDER BY time_unix_nano DESC,sample_id DESC LIMIT {limit:UInt32}`;
}

// Resent copies of a point are identical, so the fetch keeps one per key rather than
// paying for FINAL, which merges every part overlapping the fetched keys.
function pointListQuery(fields: string[]) {
	const projected = fields.length ? `[${fields.join(",")}] AS fields,` : "";
	return `SELECT ${projected}hex(sample_id) AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_nano) AS timeNs,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
resource_kind AS resourceKind,metric_kind AS kind,toString(int_value) AS integer,double_value AS double,toString(count) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM metric_points WHERE project_id={project:String} AND event_day IN {days:Array(UInt32)}
AND (source_id,resource_id,metric_name,time_unix_nano) IN {series:Array(Tuple(String,String,String,UInt64))}
AND hex(sample_id) IN {samples:Array(String)}
ORDER BY time_unix_nano DESC,sample_id DESC LIMIT 1 BY time_unix_nano,sample_id`;
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
	const conditions = [...filters.conditions];
	if (input.metric !== undefined)
		conditions.push("metric_name={metric:String}");
	const fields = input.fields ?? [];
	const projections = compileFields(fields);
	const params = {
		...filters.params,
		...(input.metric === undefined ? {} : { metric: input.metric }),
		project: input.projectId,
	};
	const fromNs = BigInt(from.getTime()) * NS_PER_MS;
	const search = await searchKeys(
		keyQuery(conditions),
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
					series: keys.map(
						(key) =>
							new TupleParam([
								key.sourceId,
								key.resourceId,
								key.metricName,
								BigInt(key.timeNs),
							]),
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
