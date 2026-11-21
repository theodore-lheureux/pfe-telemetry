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
	use_skip_indexes_for_top_k: 1,
	use_top_k_dynamic_filtering: 1,
	max_execution_time: 6,
	max_threads: 1,
	max_block_size: "4096",
	optimize_move_to_prewhere_if_final: 0,
	max_memory_usage: "67108864",
	max_rows_to_read: "4000000",
	max_bytes_to_read: "536870912",
	read_overflow_mode: "throw",
	max_result_rows: "201",
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
interface PointRow {
	sampleId: string;
	seriesId: string;
	metricName: string;
	timeMs: string;
	partition: number;
	offset: string;
	integer: string | null;
	double: number | null;
	count: string | null;
	flags: number;
}
interface SeriesRow {
	seriesId: string;
	metricName: string;
	sourceId: string;
	resourceId: string;
	hostId: string | null;
	resourceKind: number;
	kind: number;
	unit: string;
	scopeName: string;
	scopeVersion: string;
	part: string;
	fields?: (string | null)[];
}
type SeriesCandidate = Pick<
	SeriesRow,
	"metricName" | "seriesId" | "resourceId"
>;
interface StreamRow {
	streamId: string;
	fields: (string | null)[];
}
interface Delivery extends DeliveryKey {
	firstMs: string;
	lastMs: string;
}

// Fixed-width hexadecimal preserves numeric series order and binary stream order.
const POINT_KEY = "concat(leftPad(hex(series_id), 16, '0'), hex(stream_id))";

function candidateQuery(metric: boolean) {
	return `SELECT toString(series_id) AS seriesId,metric_name AS metricName,
resource_id AS resourceId
FROM metric_series
WHERE project_id={project:String} AND source_id={source:String}
${metric ? "AND metric_name={metric:String}" : ""}
AND ({hasSeries:UInt8}=0 OR (series_id,metric_name)<({series:UInt64},{seriesMetric:String})
 OR ({insideSeries:UInt8}=1 AND (series_id,metric_name)=({series:UInt64},{seriesMetric:String})))
GROUP BY metric_name,series_id,resource_id
HAVING min(first_seen_unix_milli)<{upper:UInt64} AND ${seriesLastSeen("{lower:UInt64}").replace("last_seen_unix_milli", "max(last_seen_unix_milli)")}
ORDER BY series_id DESC,metric_name DESC LIMIT ${SERIES_BATCH + 1}`;
}

function batchQuery(
	pointFilters: string[],
	execution: boolean,
	evidence: boolean,
) {
	const matches = `SELECT metric_name,series_id,stream_id,time_unix_milli,raw_partition,raw_offset,
value_kind,int_value,double_value,statistics_present,count,flags
FROM metric_points FINAL
WHERE project_id={project:String} AND metric_name IN {metrics:Array(String)}
AND (metric_name,series_id) IN {seriesKeys:Array(Tuple(String,UInt64))}
AND event_day>={firstDay:UInt32} AND event_day<={lastDay:UInt32}
AND time_unix_milli>={lower:UInt64} AND time_unix_milli<{upper:UInt64}
AND raw_partition={partition:UInt32} AND raw_offset={offset:UInt64}
AND ({insideSeries:UInt8}=0 OR (series_id,metric_name,time_unix_milli,hex(stream_id))<
 ({series:UInt64},{seriesMetric:String},{cursorTime:UInt64},{cursorStream:String}))`;
	const source = execution
		? `SELECT p.*, {source:String} AS source_id, s.resource_id, s.resource_kind FROM (${matches}) p
INNER JOIN (SELECT k.1 AS metric_name,k.2 AS series_id,k.3 AS resource_id,k.4 AS resource_kind
FROM (SELECT arrayJoin({executionKeys:Array(Tuple(String,UInt64,String,UInt8))}) AS k)) s USING (metric_name,series_id)`
		: matches;
	const points = evidence
		? `SELECT * FROM ${streamEvidenceSource(source)}`
		: source;
	return `SELECT toString(time_unix_milli) AS timeMs,${POINT_KEY} AS sampleId,toString(series_id) AS seriesId,metric_name AS metricName,
raw_partition AS partition,toString(raw_offset) AS offset,
if(value_kind=1,toString(int_value),NULL) AS integer,if(value_kind=2,double_value,NULL) AS double,
toString(if(bitTest(statistics_present,0),count,NULL)) AS count,flags
FROM ${execution ? executionPointSource(points) : `(${points})`}
${pointFilters.length ? `WHERE ${pointFilters.join(" AND ")}` : ""}
ORDER BY series_id DESC,metric_name DESC,time_unix_milli DESC,stream_id DESC LIMIT {limit:UInt32}`;
}

const seriesListSelect = `SELECT toString(series_id) AS seriesId,metric_name AS metricName,_part AS part,
source_id AS sourceId,resource_id AS resourceId,nullIf(host_id,'') AS hostId,
toUInt8(resource_kind) AS resourceKind,toUInt8(metric_kind) AS kind,unit,scope_name AS scopeName,scope_version AS scopeVersion
FROM metric_series
PREWHERE project_id={project:String} AND metric_name IN {metrics:Array(String)}`;

const PAGE_SIZE = 100;
const SERIES_BATCH = 200;
const RECEIPTS_PER_SEARCH = 8;
const MAX_SEARCHES = 16;
const SEARCH_BUDGET_MS = 4000;
const MS_PER_DAY = 86_400_000n;

function summary(
	projectId: string,
	row: PointRow & SeriesRow,
	fields: PointSummary["fields"],
): PointSummary {
	return {
		sampleId: row.sampleId,
		sourceId: row.sourceId,
		resourceId: row.resourceId,
		metricName: row.metricName,
		timeMs: row.timeMs,
		node: row.hostId
			? activityNode(
					projectId,
					row.hostId,
					fields['resource.attributes["host.name"]'] ?? "",
				)
			: null,
		resourceKind: row.resourceKind,
		kind: row.kind,
		value: (row.flags & 1) === 0 ? (row.integer ?? row.double) : null,
		count: row.count,
		unit: row.unit,
		measuredAt: new Date(Number(row.timeMs)),
		flags: row.flags,
		scopeName: row.scopeName,
		scopeVersion: row.scopeVersion,
		fields,
	};
}

function deliveryQuery(metric: boolean) {
	const sourceFilter = metric
		? `AND source_id IN (SELECT DISTINCT source_id FROM metric_series WHERE project_id={project:String} AND metric_name={metric:String})`
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
		inDelivery: Number(cursor?.series !== undefined),
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
type ResolveCandidates = (keys: SeriesCandidate[]) => Promise<SeriesRow[]>;

function hasBudget(budget: SearchBudget) {
	return budget.remaining > 0 && Date.now() < budget.deadline;
}

async function readDelivery(
	candidatesSql: string,
	pointsSql: string,
	params: Params,
	delivery: Delivery,
	cursor: PointCursor,
	budget: SearchBudget,
	limit: number,
	readCandidates: Read<SeriesCandidate>,
	resolveCandidates: ResolveCandidates,
	read: Read<PointRow>,
	execution: boolean,
) {
	const start = max(BigInt(cursor.from.getTime()), BigInt(delivery.firstMs));
	const end = min(BigInt(cursor.to.getTime()), BigInt(delivery.lastMs) + 1n);
	const rows: PointRow[] = [];
	const dimensions: SeriesRow[] = [];
	let series = cursor.series;
	if (end <= start) return { rows, dimensions };
	while (hasBudget(budget)) {
		budget.remaining--;
		const bounds = {
			...params,
			source: delivery.sourceId,
			partition: delivery.partition,
			offset: delivery.offset,
			firstDay: Number(start / MS_PER_DAY),
			lastDay: Number((end - 1n) / MS_PER_DAY),
			lower: start.toString(),
			upper: end.toString(),
			hasSeries: Number(series !== undefined),
			insideSeries: Number(series?.point !== undefined),
			series: series?.seriesId ?? "0",
			seriesMetric: series?.metricName ?? "",
			cursorTime: series?.point?.timeMs ?? "0",
			cursorStream: series?.point?.sampleId.slice(16) ?? "",
		};
		const candidates = await readCandidates(candidatesSql, bounds);
		const selected = candidates.slice(0, SERIES_BATCH);
		if (!selected.length) return { rows, dimensions };
		const eligible = await resolveCandidates(selected);
		const found = eligible.length
			? await read(pointsSql, {
					...bounds,
					metrics: [...new Set(eligible.map((row) => row.metricName))],
					seriesKeys: eligible.map(
						(row) => new TupleParam([row.metricName, BigInt(row.seriesId)]),
					),
					...(execution
						? {
								executionKeys: eligible.map(
									(row) =>
										new TupleParam([
											row.metricName,
											BigInt(row.seriesId),
											row.resourceId,
											row.resourceKind,
										]),
								),
							}
						: {}),
					limit: limit - rows.length,
				})
			: [];
		rows.push(...found);
		dimensions.push(...eligible);
		if (rows.length === limit) {
			const last = rows[limit - 2];
			return {
				rows,
				dimensions,
				series: {
					seriesId: last.seriesId,
					metricName: last.metricName,
					point: { timeMs: last.timeMs, sampleId: last.sampleId },
				},
			};
		}
		if (candidates.length <= SERIES_BATCH) return { rows, dimensions };
		const last = selected[selected.length - 1];
		series = { seriesId: last.seriesId, metricName: last.metricName };
	}
	return { rows, dimensions, series };
}

interface PageSearch {
	rows: PointRow[];
	dimensions: SeriesRow[];
	nextCursor: PointCursor | null;
}

async function searchDeliveries(
	picker: string,
	candidates: string,
	points: string,
	params: Params,
	window: Pick<PointCursor, "from" | "to" | "receivedThrough">,
	cursor: PointCursor | undefined,
	readReceipts: Read<Delivery>,
	readCandidates: Read<SeriesCandidate>,
	resolveCandidates: ResolveCandidates,
	readRows: Read<PointRow>,
	execution: boolean,
): Promise<PageSearch> {
	const rows: PointRow[] = [];
	const dimensions: SeriesRow[] = [];
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
			return { rows, dimensions, nextCursor: nextCursor ?? null };
		}
		if (rows.length === PAGE_SIZE)
			return { rows, dimensions, nextCursor: nextCursor ?? null };
		const series =
			cursor && sameDelivery(cursor.delivery, delivery)
				? cursor.series
				: undefined;
		const current = { ...window, delivery, series };
		const limit = PAGE_SIZE + 1 - rows.length;
		const batch = await readDelivery(
			candidates,
			points,
			params,
			delivery,
			current,
			budget,
			limit,
			readCandidates,
			resolveCandidates,
			readRows,
			execution,
		);
		rows.push(...batch.rows.slice(0, limit - 1));
		dimensions.push(...batch.dimensions);
		nextCursor = { ...window, delivery, series: batch.series };
		if (batch.series) return { rows, dimensions, nextCursor };
	}
	return {
		rows,
		dimensions,
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
	const metric = input.metric !== undefined;
	const fields = input.fields ?? [];
	const seriesFields = fields.filter((field) => !isContinuityField(field));
	const streamFields = fields.filter(isContinuityField);
	const projection = compileFields(seriesFields);
	const execution = fieldsInFilters.includes("execution");
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
	const { rows, dimensions, nextCursor } = await searchDeliveries(
		deliveryQuery(metric),
		candidateQuery(metric),
		batchQuery(
			pointConditions,
			execution,
			fieldsInFilters.some(isContinuityField),
		),
		params,
		{ from, to, receivedThrough },
		input.cursor,
		(sql, params) => query<Delivery>(sql, params, signal, connection),
		(sql, params) => query<SeriesCandidate>(sql, params, signal, connection),
		(keys) =>
			resolveSeriesCandidates(
				input.projectId,
				keys,
				conditions,
				filters.params,
				signal,
				connection,
			),
		(sql, params) => query<PointRow>(sql, params, signal, connection),
		execution,
	);
	const displayed = new Set(rows.map(seriesKey));
	const displayedDimensions = dimensions.filter((row) =>
		displayed.delete(seriesKey(row)),
	);
	for (let i = 0; i < displayedDimensions.length; i += 20)
		await readSeriesFields(
			input.projectId,
			displayedDimensions.slice(i, i + 20),
			projection,
			signal,
			connection,
		);
	const evidence = rows.length
		? await readStreamFields(
				input.projectId,
				rows,
				compileFields(streamFields),
				signal,
				connection,
			)
		: [];
	const points = assemblePage(
		input.projectId,
		rows,
		displayedDimensions,
		evidence,
		seriesFields,
		streamFields,
	);
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

async function resolveSeriesCandidates(
	project: string,
	keys: SeriesCandidate[],
	conditions: string[],
	filterParams: Params,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
) {
	const sql = `${seriesListSelect}
AND (metric_name,resource_id,series_id) IN {candidateIds:Array(Tuple(String,String,UInt64))}
${conditions.length ? `WHERE ${conditions.map((condition) => `(${condition})`).join(" AND ")}` : ""}
LIMIT 1 BY metric_name,series_id`;
	const size = conditions.length ? 20 : SERIES_BATCH;
	const result: SeriesRow[] = [];
	for (let index = 0; index < keys.length; index += size) {
		const chunk = keys.slice(index, index + size);
		result.push(
			...(await query<SeriesRow>(
				sql,
				{
					...filterParams,
					project,
					metrics: [...new Set(chunk.map((row) => row.metricName))],
					candidateIds: chunk.map(
						(row) =>
							new TupleParam([
								row.metricName,
								row.resourceId,
								BigInt(row.seriesId),
							]),
					),
				},
				signal,
				connection,
			)),
		);
	}
	return result;
}

async function readSeriesFields(
	project: string,
	dimensions: SeriesRow[],
	projection: ReturnType<typeof compileFields>,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
	retry = true,
) {
	if (!dimensions.length || !projection.expressions.length) return;
	const rows = await query<
		Pick<SeriesRow, "metricName" | "seriesId" | "fields">
	>(
		`SELECT metric_name AS metricName,toString(series_id) AS seriesId,[${projection.expressions.join(",")}] AS fields
FROM metric_series
PREWHERE project_id={project:String}
AND metric_name IN {metrics:Array(String)} AND resource_id IN {resources:Array(String)}
AND _part IN {parts:Array(String)}
AND (metric_name,resource_id,series_id,_part) IN {ids:Array(Tuple(String,String,UInt64,String))}
LIMIT 1 BY metric_name,series_id`,
		{
			...projection.params,
			project,
			metrics: [...new Set(dimensions.map((row) => row.metricName))],
			resources: [...new Set(dimensions.map((row) => row.resourceId))],
			parts: [...new Set(dimensions.map((row) => row.part))],
			ids: dimensions.map(
				(row) =>
					new TupleParam([
						row.metricName,
						row.resourceId,
						BigInt(row.seriesId),
						row.part,
					]),
			),
		},
		signal,
		connection,
	);
	const fields = new Map(rows.map((row) => [seriesKey(row), row.fields]));
	for (const row of dimensions) row.fields = fields.get(seriesKey(row));
	const missing = dimensions.filter((row) => !row.fields);
	if (!missing.length) return;
	if (!retry)
		throw new OperationError(
			"UNAVAILABLE",
			"Measurement dimensions changed during the query",
		);
	// A background merge can replace the selected part between the two reads.
	const refreshed = await query<SeriesRow>(
		`${seriesListSelect}
AND (metric_name,resource_id,series_id) IN {ids:Array(Tuple(String,String,UInt64))}
LIMIT 1 BY metric_name,series_id`,
		{
			project,
			metrics: [...new Set(missing.map((row) => row.metricName))],
			ids: missing.map(
				(row) =>
					new TupleParam([
						row.metricName,
						row.resourceId,
						BigInt(row.seriesId),
					]),
			),
		},
		signal,
		connection,
	);
	await readSeriesFields(
		project,
		refreshed,
		projection,
		signal,
		connection,
		false,
	);
	const replacements = new Map(
		refreshed.map((row) => [seriesKey(row), row.fields]),
	);
	for (const row of missing) row.fields = replacements.get(seriesKey(row));
}

function seriesKey(key: Pick<SeriesRow, "metricName" | "seriesId">) {
	return JSON.stringify([key.metricName, key.seriesId]);
}

async function readStreamFields(
	project: string,
	rows: PointRow[],
	projection: ReturnType<typeof compileFields>,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
) {
	if (!projection.expressions.length) return [];
	return query<StreamRow>(
		`SELECT hex(stream_id) AS streamId,[${projection.expressions.join(",")}] AS fields
FROM (SELECT *, toUInt8(1) AS evidence_present FROM metric_streams
PREWHERE project_id={project:String} AND stream_id IN arrayMap(id -> toFixedString(unhex(id),16), {streams:Array(String)}))
LIMIT 1 BY streamId`,
		{
			...projection.params,
			project,
			streams: [...new Set(rows.map((row) => row.sampleId.slice(16)))],
		},
		signal,
		connection,
	);
}

function assemblePage(
	project: string,
	rows: PointRow[],
	dimensions: SeriesRow[],
	evidence: StreamRow[],
	seriesFields: string[],
	streamFields: string[],
) {
	const seriesByKey = new Map(dimensions.map((row) => [seriesKey(row), row]));
	const streamByKey = new Map(
		evidence.map((row) => [row.streamId, row.fields]),
	);
	return rows.flatMap((row) => {
		const series = seriesByKey.get(seriesKey(row));
		if (!series) return [];
		const stream = streamByKey.get(row.sampleId.slice(16));
		if (streamFields.length && !stream)
			throw new OperationError(
				"UNAVAILABLE",
				"Measurement continuity is not yet available",
			);
		return [
			summary(
				project,
				{ ...row, ...series },
				Object.fromEntries([
					...seriesFields.map((field, i) => [
						field,
						series.fields?.[i] ?? null,
					]),
					...streamFields.map((field, i) => [field, stream?.[i] ?? null]),
				]),
			),
		];
	});
}

export async function readPoint(
	input: PointInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<PointDetail> {
	const row = await readDetailRows(input, signal, connection);
	const select = (names: string[]) =>
		Object.fromEntries(
			names.map((key) => [key, row[key] ?? null]),
		) as JsonObject;
	const [delivery] = await query<{
		request: string;
		contextId: string;
		received: string;
		oldest: string;
		newest: string;
	}>(
		`SELECT hex(delivery_request) AS request, hex(delivery_context_id) AS contextId, toString(received_unix_nano) AS received,
		  toString(min_event_unix_milli) AS oldest, toString(max_event_unix_milli) AS newest
		FROM deliveries FINAL WHERE project_id={project:String} AND source_id={source:String}
		  AND raw_partition={partition:UInt32} AND raw_offset={offset:UInt64}
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
	const [context] = await query<{ payload: string }>(
		`SELECT hex(delivery_context) AS payload FROM delivery_contexts
WHERE project_id={project:String} AND source_id={source:String} AND delivery_context_id=unhex({id:String})
LIMIT 1`,
		{
			project: input.projectId,
			source: input.sourceId,
			id: delivery.contextId,
		},
		signal,
		connection,
	);
	if (!context)
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
		...decodeDelivery(delivery.request, context.payload, {
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

function inspectorAttributes(expression: string, alias: string) {
	return `arrayMap(a -> CAST(tuple(a.path,a.kind,a.string_value,a.int_value,a.double_value,a.bool_value,base64Encode(a.bytes_value)), 'Tuple(path String,kind UInt8,string_value Nullable(String),int_value Nullable(Int64),double_value Nullable(Float64),bool_value Nullable(UInt8),bytes_value Nullable(String))'),${expression}) AS ${alias}`;
}

function restoreAttributes(
	dimensions: JsonValue | undefined,
	markers: JsonValue | undefined,
) {
	const nodes = [...(dimensions as JsonObject[]), ...(markers as JsonObject[])];
	return nodes.sort((a, b) =>
		Buffer.compare(Buffer.from(String(a.path)), Buffer.from(String(b.path))),
	);
}

async function readDetailRows(
	input: PointInput,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<JsonObject> {
	const params = {
		project: input.projectId,
		source: input.sourceId,
		resource: input.resourceId,
		metric: input.metricName,
		day: Number(BigInt(input.timeMs) / MS_PER_DAY),
		time: input.timeMs,
		series: BigInt(`0x${input.sampleId.slice(0, 16)}`).toString(),
		stream: input.sampleId.slice(16),
	};
	const [series] = await query<JsonObject>(
		`SELECT source_id,resource_id,toUInt8(resource_kind) AS resource_kind,nullIf(host_id,'') AS host_id,
resource_schema_url,scope_schema_url,scope_name,scope_version,resource_present,scope_present,
resource_dropped_attributes_count,scope_dropped_attributes_count,description,unit,
toUInt8(metric_kind) AS metric_kind,toUInt8(temporality) AS temporality,nullIf(toUInt8(monotonic),2) AS monotonic,
arrayMap(value -> base64Encode(value),resource_entity_refs) AS resource_entity_refs,
${["resource_attributes", "scope_attributes", "point_attributes", "metric_metadata"].map((name) => inspectorAttributes(`metric_series.${name}`, name)).join(",")}
FROM metric_series
PREWHERE project_id={project:String} AND source_id={source:String} AND resource_id={resource:String}
AND metric_name={metric:String} AND series_id={series:UInt64}
GROUP BY ALL HAVING min(first_seen_unix_milli) <= {time:UInt64}
AND ${seriesLastSeen("{time:UInt64}").replace("last_seen_unix_milli", "max(last_seen_unix_milli)")}
LIMIT 1`,
		params,
		signal,
		connection,
	);
	if (!series) throw new OperationError("NOT_FOUND", "Measurement not found");
	const [point] = await query<JsonObject>(
		`SELECT * EXCEPT(stream_id,exemplars,value_kind,statistics_present)
REPLACE (if(value_kind=1,int_value,NULL) AS int_value, if(value_kind=2,double_value,NULL) AS double_value,
${["count", "sum", "min", "max", "scale", "zero_count", "zero_threshold", "positive_offset", "negative_offset"].map((name, i) => `if(bitTest(statistics_present,${i}),${name},NULL) AS ${name}`).join(",")}),
hex(stream_id) AS stream_id,arrayMap(value -> base64Encode(value),metric_points.exemplars) AS exemplars
FROM metric_points
PREWHERE project_id={project:String} AND metric_name={metric:String} AND series_id={series:UInt64}
AND event_day={day:UInt32} AND time_unix_milli={time:UInt64} AND metric_points.stream_id=unhex({stream:String})
ORDER BY raw_offset DESC LIMIT 1`,
		params,
		signal,
		connection,
	);
	if (!point) throw new OperationError("NOT_FOUND", "Measurement not found");
	const [stream] = await query<JsonObject>(
		`SELECT ${inspectorAttributes("arrayMap(c -> c.node, resource_continuity)", "resource_markers")},
${inspectorAttributes("arrayMap(c -> c.node, point_continuity)", "point_markers")}
FROM metric_streams PREWHERE project_id={project:String} AND stream_id=unhex({stream:String}) LIMIT 1`,
		params,
		signal,
		connection,
	);
	if (!stream)
		throw new OperationError(
			"UNAVAILABLE",
			"Measurement continuity is not yet available",
		);
	return {
		...point,
		...series,
		resource_attributes: restoreAttributes(
			series.resource_attributes,
			stream.resource_markers,
		),
		point_attributes: restoreAttributes(
			series.point_attributes,
			stream.point_markers,
		),
	};
}
