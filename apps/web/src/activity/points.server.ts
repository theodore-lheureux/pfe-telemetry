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
	DeliveryKey,
	ExplorerInput,
	JsonObject,
	JsonValue,
	PointCursor,
	PointDetail,
	PointInput,
	PointPage,
	PointSummary,
} from "./contracts";

const settings = {
	...POINT_FINAL_SETTINGS,
	max_execution_time: 6,
	max_threads: 1,
	max_block_size: "4096",
	optimize_move_to_prewhere_if_final: 0,
	max_memory_usage: "67108864",
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
const READ_LIMIT_CODES = new Set(["158", "307", "241"]);
class ReadLimitError extends OperationError {
	constructor() {
		super("CAPACITY", "Activity query exceeded its read budget");
	}
}
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
	partition: number;
	offset: string;
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
	metricName: string;
	day: number;
}
type ReceiptPointKey = Key & Pick<DeliveryKey, "partition" | "offset">;
interface Delivery extends DeliveryKey {
	firstMs: string;
	lastMs: string;
}

// Fixed-width hexadecimal preserves numeric series order and binary stream order.
const POINT_KEY = "concat(leftPad(hex(series_id), 16, '0'), hex(stream_id))";

function keyQuery(
	seriesFilters: string[],
	pointFilters: string[],
	execution: boolean,
	evidence: boolean,
	metric: boolean,
) {
	const selected = `SELECT metric_name, series_id${execution ? ", source_id, resource_id, resource_kind" : ""}
FROM metric_series FINAL
WHERE project_id={project:String} AND source_id={source:String}${seriesFilters.map((condition) => ` AND (${condition})`).join("")}`;
	const timeKeys = `SELECT metric_name, series_id, stream_id, time_unix_milli, event_day
FROM metric_points FINAL
WHERE project_id={project:String}${metric ? " AND metric_name={metric:String}" : ""}
AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_milli>={lower:UInt64} AND time_unix_milli<{upper:UInt64}
AND raw_partition={partition:UInt32} AND raw_offset={offset:UInt64}
AND ({cursorSample:String}='' OR tuple(time_unix_milli,${POINT_KEY})<tuple({cursorTime:UInt64},{cursorSample:String}))`;
	const source = execution
		? `SELECT p.*, s.source_id, s.resource_id, s.resource_kind FROM (${timeKeys}) p
INNER JOIN (${selected}) s USING (metric_name,series_id)`
		: `${timeKeys} AND (metric_name,series_id) IN (${selected})`;
	const points = evidence
		? `SELECT * FROM ${streamEvidenceSource(source)}`
		: source;
	return `SELECT toString(time_unix_milli) AS timeMs,${POINT_KEY} AS sampleId,toString(series_id) AS seriesId,metric_name AS metricName,event_day AS day
FROM ${execution ? executionPointSource(points) : `(${points})`}
${pointFilters.length ? `WHERE ${pointFilters.join(" AND ")}` : ""}
ORDER BY time_unix_milli DESC,series_id DESC,stream_id DESC LIMIT {limit:UInt32}`;
}

function pointListQuery(fields: string[], evidence: boolean) {
	const projected = fields.length ? `[${fields.join(",")}] AS fields,` : "";
	const points = seriesPointSource(
		" AND (metric_name, series_id) IN {ids:Array(Tuple(String,UInt64))}",
		`AND event_day IN {days:Array(UInt32)}
AND metric_name IN {metrics:Array(String)}
AND time_unix_milli BETWEEN {firstPoint:UInt64} AND {lastPoint:UInt64}
AND series_id IN arrayMap(id -> toUInt64(id), {seriesIds:Array(String)})
AND (metric_name,series_id,time_unix_milli) IN {series:Array(Tuple(String,UInt64,UInt64))}
AND ${POINT_KEY} IN {samples:Array(String)}
AND (raw_partition,raw_offset) IN {receipts:Array(Tuple(UInt32,UInt64))}`,
	);
	const source = evidence
		? streamEvidenceSource(
				points,
				" AND stream_id IN arrayMap(id -> toFixedString(unhex(id), 16), {streams:Array(String)})",
			)
		: `(${points})`;
	return `SELECT ${projected}${POINT_KEY} AS sampleId,source_id AS sourceId,resource_id AS resourceId,metric_name AS metricName,toString(time_unix_milli) AS timeMs,raw_partition AS partition,toString(raw_offset) AS offset,
host_id AS hostId,arrayFirst(a -> a.path='/host.name' AND a.kind=2,resource_attributes).string_value AS hostname,
toUInt8(resource_kind) AS resourceKind,toUInt8(metric_kind) AS kind,toString(int_value) AS integer,double_value AS double,toString(if(bitTest(statistics_present,0),count,NULL)) AS count,unit,flags,scope_name AS scopeName,scope_version AS scopeVersion
FROM ${source}
ORDER BY time_unix_milli DESC,sampleId DESC`;
}

const PAGE_SIZE = 100;
const RECEIPTS_PER_SEARCH = 8;
const MAX_SEARCHES = 16;
const SEARCH_BUDGET_MS = 4000;
const MS_PER_DAY = 86_400_000n;

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

function deliveryQuery(seriesFilters: string[]) {
	const sourceFilter = seriesFilters.length
		? `AND source_id IN (SELECT source_id FROM metric_series FINAL WHERE project_id={project:String}
${seriesFilters.map((condition) => ` AND (${condition})`).join("")})`
		: "";
	return `SELECT toString(received_unix_nano) AS receivedNs, source_id AS sourceId,
raw_partition AS partition, toString(raw_offset) AS offset,
toString(min_event_unix_milli) AS firstMs, toString(max_event_unix_milli) AS lastMs
FROM deliveries FINAL WHERE project_id={project:String}
AND max_event_unix_milli >= {from:UInt64} AND min_event_unix_milli < {to:UInt64}
AND received_unix_nano < {receivedThrough:UInt64}
${sourceFilter}
AND ({hasCursor:UInt8}=0 OR
    (received_unix_nano,source_id,raw_partition,raw_offset) <
    ({receivedNs:UInt64},{source:String},{partition:UInt32},{offset:UInt64})
    OR ({inDelivery:UInt8}=1 AND
    (received_unix_nano,source_id,raw_partition,raw_offset) =
    ({receivedNs:UInt64},{source:String},{partition:UInt32},{offset:UInt64})))
ORDER BY received_unix_nano DESC,source_id DESC,raw_partition DESC,raw_offset DESC
LIMIT ${RECEIPTS_PER_SEARCH}`;
}

function deliveryParams(cursor?: PointCursor) {
	return {
		hasCursor: Number(cursor !== undefined),
		inDelivery: Number(cursor?.point !== undefined),
		receivedNs: cursor?.delivery.receivedNs ?? "0",
		source: cursor?.delivery.sourceId ?? "",
		partition: cursor?.delivery.partition ?? 0,
		offset: cursor?.delivery.offset ?? "0",
	};
}

function sameDelivery(a: DeliveryKey, b: DeliveryKey) {
	return (
		a.receivedNs === b.receivedNs &&
		a.sourceId === b.sourceId &&
		a.partition === b.partition &&
		a.offset === b.offset
	);
}

function min(a: bigint, b: bigint) {
	return a < b ? a : b;
}

function max(a: bigint, b: bigint) {
	return a > b ? a : b;
}

interface SearchBudget {
	remaining: number;
	deadline: number;
}
type Read<T> = (sql: string, params: Params) => Promise<T[]>;

function hasBudget(budget: SearchBudget) {
	return budget.remaining > 0 && Date.now() < budget.deadline;
}

async function readDelivery(
	sql: string,
	params: Params,
	delivery: Delivery,
	cursor: PointCursor,
	budget: SearchBudget,
	limit: number,
	read: Read<Key>,
) {
	const start = max(BigInt(cursor.from.getTime()), BigInt(delivery.firstMs));
	const end = min(BigInt(cursor.to.getTime()), BigInt(delivery.lastMs) + 1n);
	let upper = end;
	if (cursor.point) {
		upper = min(
			upper,
			BigInt(cursor.point.timeMs) + (cursor.point.sampleId ? 1n : 0n),
		);
	}
	let span = upper - start;
	const initialUpper = upper;
	let point = cursor.point;
	const keys: Key[] = [];
	while (upper > start && hasBudget(budget)) {
		const lower = max(start, upper - span);
		const wanted = limit - keys.length;
		let batch: Key[];
		budget.remaining--;
		try {
			batch = await read(sql, {
				...params,
				...deliveryParams(cursor),
				firstDay: Number(lower / MS_PER_DAY),
				lastDay: Number((upper - 1n) / MS_PER_DAY),
				lower: lower.toString(),
				upper: upper.toString(),
				cursorTime: point?.timeMs ?? "0",
				cursorSample: point?.sampleId ?? "",
				limit: wanted,
			});
		} catch (error) {
			if (!(error instanceof ReadLimitError)) throw error;
			if (upper - lower === 1n)
				throw new OperationError("CAPACITY", "Activity delivery is too dense");
			span = (upper - lower) / 2n;
			continue;
		}
		keys.push(...batch);
		// Keep the lookahead row on the next page, including when it shares a timestamp.
		if (keys.length === limit) {
			const last = keys.at(-2);
			return {
				keys,
				point: last ? { timeMs: last.timeMs, sampleId: last.sampleId } : point,
			};
		}
		upper = lower;
		point = { timeMs: upper.toString() };
	}
	if (upper > start && upper === initialUpper)
		throw new OperationError("CAPACITY", "Activity delivery is too dense");
	return {
		keys,
		point: upper > start ? (point ?? { timeMs: upper.toString() }) : undefined,
	};
}

interface PageSearch {
	keys: ReceiptPointKey[];
	nextCursor: PointCursor | null;
}

async function searchDeliveries(
	picker: string,
	points: string,
	params: Params,
	window: Pick<PointCursor, "from" | "to" | "receivedThrough">,
	cursor: PointCursor | undefined,
	readReceipts: Read<Delivery>,
	readKeys: Read<Key>,
): Promise<PageSearch> {
	const keys: ReceiptPointKey[] = [];
	const budget = {
		remaining: MAX_SEARCHES,
		deadline: Date.now() + SEARCH_BUDGET_MS,
	};
	const deliveries = await readReceipts(picker, {
		...params,
		...deliveryParams(cursor),
	});
	let nextCursor = cursor;
	for (const delivery of deliveries) {
		if (!hasBudget(budget)) {
			if (nextCursor === cursor)
				throw new OperationError("CAPACITY", "Activity search took too long");
			return { keys, nextCursor: nextCursor ?? null };
		}
		if (keys.length === PAGE_SIZE)
			return { keys, nextCursor: nextCursor ?? null };
		const point =
			cursor && sameDelivery(cursor.delivery, delivery)
				? cursor.point
				: undefined;
		const current = { ...window, delivery, point };
		const limit = PAGE_SIZE + 1 - keys.length;
		const batch = await readDelivery(
			points,
			params,
			delivery,
			current,
			budget,
			limit,
			readKeys,
		);
		keys.push(
			...batch.keys.slice(0, limit - 1).map((key) => ({
				...key,
				partition: delivery.partition,
				offset: delivery.offset,
			})),
		);
		nextCursor = { ...window, delivery, point: batch.point };
		if (batch.point) return { keys, nextCursor };
	}
	return {
		keys,
		nextCursor:
			deliveries.length === RECEIPTS_PER_SEARCH ? (nextCursor ?? null) : null,
	};
}

export async function readPoints(
	input: ExplorerInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointPage> {
	const to = input.cursor?.to ?? input.to ?? new Date(),
		from = input.cursor?.from ?? input.from ?? new Date(to.getTime() - 3600000);
	const receivedThrough =
		input.cursor?.receivedThrough ?? new Date(Date.now() + 1);
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
		receivedThrough: (
			BigInt(receivedThrough.getTime()) * 1_000_000n
		).toString(),
	};
	const { keys, nextCursor } = await searchDeliveries(
		deliveryQuery(conditions),
		keyQuery(
			conditions,
			pointConditions,
			fieldsInFilters.includes("execution"),
			fieldsInFilters.some(isContinuityField),
			input.metric !== undefined,
		),
		params,
		{ from, to, receivedThrough },
		input.cursor,
		(sql, params) => query<Delivery>(sql, params, signal, connection),
		(sql, params) => query<Key>(sql, params, signal, connection),
	);
	const rows: Row[] = [];
	const hydrate = pointListQuery(
		projections.expressions,
		fields.some(isContinuityField),
	);
	// The ClickHouse client sends query parameters in the URL.
	for (let index = 0; index < keys.length; index += 20) {
		const chunk = keys.slice(index, index + 20);
		const times = chunk.map((key) => BigInt(key.timeMs));
		rows.push(
			...(await query<Row>(
				hydrate,
				{
					...projections.params,
					project: input.projectId,
					firstPoint: times.reduce(min).toString(),
					lastPoint: times.reduce(max).toString(),
					days: [...new Set(chunk.map((key) => key.day))],
					metrics: [...new Set(chunk.map((key) => key.metricName))],
					seriesIds: [...new Set(chunk.map((key) => key.seriesId))],
					ids: chunk.map(
						(key) => new TupleParam([key.metricName, BigInt(key.seriesId)]),
					),
					series: chunk.map(
						(key) =>
							new TupleParam([
								key.metricName,
								BigInt(key.seriesId),
								BigInt(key.timeMs),
							]),
					),
					samples: chunk.map((key) => key.sampleId),
					receipts: chunk.map(
						(key) => new TupleParam([key.partition, BigInt(key.offset)]),
					),
					streams: [...new Set(chunk.map((key) => key.sampleId.slice(16)))],
				},
				signal,
				connection,
			)),
		);
	}
	const identity = (
		key: Pick<Row, "timeMs" | "sampleId" | "partition" | "offset">,
	) => `${key.timeMs}/${key.sampleId}/${key.partition}/${key.offset}`;
	const byKey = new Map(rows.map((row) => [identity(row), row]));
	const points = keys.flatMap((key) => {
		const row = byKey.get(identity(key));
		return row ? [summary(input.projectId, row, fields)] : [];
	});
	return {
		points,
		from,
		to,
		searchedTo: nextCursor
			? new Date(Number(BigInt(nextCursor.delivery.receivedNs) / 1_000_000n))
			: from,
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
