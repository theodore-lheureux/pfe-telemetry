import type { ClickHouseClient } from "@clickhouse/client";
import { readExecutions } from "../executions/participants.server";
import { compileFields } from "./compile.server";
import type { AttributeDefinition, MetricDefinition } from "./contracts";
import { metricBehavior } from "./validation";

// Catalog reads are small: aggregated definition rows, never raw points.
const SETTINGS = {
	max_execution_time: 5,
	max_threads: 1,
	max_memory_usage: "134217728",
	max_result_rows: "5000",
	result_overflow_mode: "throw",
	output_format_json_quote_64bit_integers: 1,
} as const;
const MAX_METRICS = 500;
const MAX_ATTRIBUTES = 500;

interface MetricRow {
	name: string;
	kind: number;
	temporality: number;
	monotonic: number;
	unit: string;
	description: string;
	firstSeenNs: string;
	lastSeenNs: string;
}

const nanosecondsDate = (value: string) =>
	new Date(Number(BigInt(value) / 1_000_000n));

function definition(row: MetricRow): MetricDefinition {
	// 2 records an unknown monotonicity in the catalog's non-nullable key.
	const monotonic = row.monotonic === 2 ? null : row.monotonic === 1;
	return {
		name: row.name,
		kind: row.kind,
		temporality: row.temporality,
		monotonic,
		unit: row.unit,
		description: row.description,
		behavior: metricBehavior(row.kind, row.temporality, monotonic),
		firstSeen: nanosecondsDate(row.firstSeenNs),
		lastSeen: nanosecondsDate(row.lastSeenNs),
	};
}

const METRICS = `SELECT metric_name AS name, metric_kind AS kind, temporality,
    monotonic_state AS monotonic, unit, anyLast(description) AS description,
    toString(min(first_seen_unix_nano)) AS firstSeenNs,
    toString(max(last_seen_unix_nano)) AS lastSeenNs
  FROM metric_definitions
  WHERE project_id = {project:String}`;

/**
 * Metrics the project has sent, newest kind first for each name. A name sent with
 * different kinds or units appears once per variant, so callers can tell them apart.
 */
export async function listMetrics(
	connection: ClickHouseClient,
	projectId: string,
	signal?: AbortSignal,
): Promise<MetricDefinition[]> {
	const result = await connection.query({
		query: `${METRICS}
  GROUP BY name, kind, temporality, monotonic, unit
  ORDER BY name, max(last_seen_unix_nano) DESC
  LIMIT ${MAX_METRICS}`,
		format: "JSONEachRow",
		query_params: { project: projectId },
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return (await result.json<MetricRow>()).map(definition);
}

/** The most recently seen variant of each metric, which decides its calculations. */
export async function metricDefinitions(
	connection: ClickHouseClient,
	projectId: string,
	metrics: string[],
	signal?: AbortSignal,
): Promise<Map<string, MetricDefinition>> {
	const result = await connection.query({
		query: `${METRICS} AND metric_name IN {metrics:Array(String)}
  GROUP BY name, kind, temporality, monotonic, unit
  ORDER BY max(last_seen_unix_nano) DESC
  LIMIT 1 BY name`,
		format: "JSONEachRow",
		query_params: { project: projectId, metrics: [...new Set(metrics)] },
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return new Map(
		(await result.json<MetricRow>()).map((row) => [row.name, definition(row)]),
	);
}

/** Attribute keys seen on one metric, for grouping and filtering choices. */
export async function listAttributes(
	connection: ClickHouseClient,
	projectId: string,
	metric?: string,
	signal?: AbortSignal,
): Promise<AttributeDefinition[]> {
	const result = await connection.query({
		query: `SELECT ${metric === undefined ? "''" : "metric_name"} AS metric, scope, attribute_key AS key, value_kind AS kind
  FROM attribute_definitions
  WHERE project_id = {project:String}${metric === undefined ? "" : " AND metric_name = {metric:String}"}
  GROUP BY metric, scope, key, kind
  ORDER BY scope, key
  LIMIT ${MAX_ATTRIBUTES}`,
		format: "JSONEachRow",
		query_params: {
			project: projectId,
			...(metric === undefined ? {} : { metric }),
		},
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return result.json<AttributeDefinition>();
}

interface AttributeRow {
	scope: "point" | "resource";
	key: string;
	kind: number;
	lastSeenNs: string;
	metrics: string[];
}

/** Metrics named for each attribute; the definitions pages show this many at most. */
export const MAX_ATTRIBUTE_METRICS = 50;

/**
 * Each attribute key the project has sent, with when it was last seen and the metrics
 * that carry it, optionally for one metric.
 */
export async function listAttributeCatalog(
	connection: ClickHouseClient,
	projectId: string,
	metric?: string,
	signal?: AbortSignal,
) {
	const result = await connection.query({
		query: `SELECT scope, attribute_key AS key, value_kind AS kind,
    toString(max(last_seen_unix_nano)) AS lastSeenNs,
    arraySort(groupUniqArray(${MAX_ATTRIBUTE_METRICS})(metric_name)) AS metrics
  FROM attribute_definitions
  WHERE project_id = {project:String}${metric === undefined ? "" : " AND metric_name = {metric:String}"}
  GROUP BY scope, key, kind
  ORDER BY scope, key
  LIMIT ${MAX_ATTRIBUTES}`,
		format: "JSONEachRow",
		query_params: {
			project: projectId,
			...(metric === undefined ? {} : { metric }),
		},
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return (await result.json<AttributeRow>()).map(({ lastSeenNs, ...row }) => ({
		...row,
		lastSeen: nanosecondsDate(lastSeenNs),
	}));
}

/** Examples come from a bounded sample of the metric's points in the last hour. */
const EXAMPLE_WINDOW_MS = 3_600_000;
const EXAMPLE_POINTS = 2000;

/**
 * One recent value for each attribute of a metric, as text, keyed by `scope/key`.
 * The sample stops after a bounded number of points, so a busy metric still answers.
 */
export async function metricAttributeExamples(
	connection: ClickHouseClient,
	projectId: string,
	metric: string,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<Map<string, string>> {
	const from = now - EXAMPLE_WINDOW_MS;
	const value = (scope: string) =>
		`arrayMap(a -> tuple('${scope}', substring(a.path, 2), coalesce(a.string_value, toString(a.int_value), toString(a.double_value), if(a.bool_value = 1, 'true', 'false'))), arrayFilter(a -> a.kind BETWEEN 2 AND 5 AND position(substring(a.path, 2), '/') = 0, ${scope === "point" ? "point_attributes" : "resource_attributes"}))`;
	const result = await connection.query({
		query: `SELECT entry.1 AS scope, entry.2 AS key, any(entry.3) AS example
  FROM (
    SELECT point_attributes, resource_attributes
    FROM metric_points
    WHERE project_id = {project:String} AND metric_name = {metric:String}
      AND event_day >= {firstDay:UInt32} AND time_unix_nano >= {from:UInt64}
    LIMIT ${EXAMPLE_POINTS}
  )
  ARRAY JOIN arrayConcat(${value("point")}, ${value("resource")}) AS entry
  GROUP BY scope, key
  LIMIT ${MAX_ATTRIBUTES}`,
		format: "JSONEachRow",
		query_params: {
			project: projectId,
			metric,
			firstDay: Math.floor(from / 86_400_000),
			from: String(BigInt(from) * 1_000_000n),
		},
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	const rows = await result.json<{
		scope: string;
		key: string;
		example: string | null;
	}>();
	return new Map(
		rows.flatMap((row) =>
			row.example === null ? [] : [[`${row.scope}/${row.key}`, row.example]],
		),
	);
}

/**
 * The most frequent values of one attribute in a bounded sample of recent points from
 * the metrics that carry it, as text.
 */
export async function attributeValueSample(
	connection: ClickHouseClient,
	projectId: string,
	scope: "point" | "resource",
	key: string,
	metrics: string[],
	signal?: AbortSignal,
	now = Date.now(),
): Promise<string[]> {
	const from = now - EXAMPLE_WINDOW_MS;
	const column = scope === "point" ? "point_attributes" : "resource_attributes";
	const result = await connection.query({
		query: `SELECT value FROM (
    SELECT arrayJoin(arrayMap(a -> coalesce(a.string_value, toString(a.int_value), toString(a.double_value), if(a.bool_value = 1, 'true', 'false')),
      arrayFilter(a -> a.path = {path:String} AND a.kind BETWEEN 2 AND 5, ${column}))) AS value
    FROM (
      SELECT ${column}
      FROM metric_points
      WHERE project_id = {project:String} AND metric_name IN {metrics:Array(String)}
        AND event_day >= {firstDay:UInt32} AND time_unix_nano >= {from:UInt64}
      LIMIT ${EXAMPLE_POINTS}
    )
  )
  WHERE value IS NOT NULL AND value != ''
  GROUP BY value
  ORDER BY count() DESC, value
  LIMIT ${MAX_VALUE_SUGGESTIONS}`,
		format: "JSONEachRow",
		query_params: {
			project: projectId,
			metrics,
			path: `/${key}`,
			firstDay: Math.floor(from / 86_400_000),
			from: String(BigInt(from) * 1_000_000n),
		},
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return (await result.json<{ value: string }>()).map((row) => row.value);
}

/** Suggested values come from the last day of points, most frequent first. */
const VALUE_WINDOW_MS = 86_400_000;
export const MAX_VALUE_SUGGESTIONS = 20;

/**
 * The values an attribute field took recently. The scan stops after a bounded number
 * of points, so a busy project gets suggestions from a sample rather than a failure.
 */
export async function listAttributeValues(
	connection: ClickHouseClient,
	projectId: string,
	field: string,
	metric: string | undefined,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<string[]> {
	if (field === "execution")
		return (await readExecutions(projectId, {}, signal, connection)).map(
			(entry) => entry.executionKey,
		);
	const {
		expressions: [value],
		params,
	} = compileFields([field]);
	const from = now - VALUE_WINDOW_MS;
	const result = await connection.query({
		query: `SELECT value FROM (
    SELECT ${value} AS value
    FROM metric_points
    WHERE project_id = {project:String}
      AND event_day >= {firstDay:UInt32}
      AND time_unix_nano >= {from:UInt64}${metric === undefined ? "" : "\n      AND metric_name = {metric:String}"}
  )
  WHERE value IS NOT NULL AND value != ''
  GROUP BY value
  ORDER BY count() DESC, value
  LIMIT ${MAX_VALUE_SUGGESTIONS}`,
		format: "JSONEachRow",
		query_params: {
			...params,
			project: projectId,
			firstDay: Math.floor(from / 86_400_000),
			from: (BigInt(from) * 1_000_000n).toString(),
			...(metric === undefined ? {} : { metric }),
		},
		abort_signal: signal,
		clickhouse_settings: {
			...SETTINGS,
			max_rows_to_read: "500000",
			read_overflow_mode: "break",
			max_rows_to_group_by: "10000",
			group_by_overflow_mode: "any",
		},
	});
	return (await result.json<{ value: string }>()).map((row) => row.value);
}
