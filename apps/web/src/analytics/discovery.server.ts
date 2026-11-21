import type { ClickHouseClient } from "@clickhouse/client";
import { readExecutions } from "../executions/participants.server";
import { compileFields, isPointField } from "./compile.server";
import type { AttributeDefinition, MetricDefinition } from "./contracts";
import {
	POINT_FINAL_SETTINGS,
	seriesLastSeen,
	seriesPointSource,
} from "./series-source.server";
import { metricBehavior } from "./validation";

// Catalogs scan series definitions, never raw samples.
const SETTINGS = {
	...POINT_FINAL_SETTINGS,
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
	firstSeenMs: string;
	lastSeenMs: string;
}

const millisecondsDate = (value: string) => new Date(Number(BigInt(value)));

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
		behavior: metricBehavior(row.kind, row.temporality, monotonic, row.name),
		firstSeen: millisecondsDate(row.firstSeenMs),
		lastSeen: millisecondsDate(row.lastSeenMs),
	};
}

const METRICS = `SELECT metric_name AS name, toUInt8(metric_kind) AS kind, toUInt8(temporality) AS temporal,
    toUInt8(monotonic) AS monotonic_state, unit, argMax(description, last_seen_unix_milli) AS description,
    toString(min(first_seen_unix_milli)) AS firstSeenMs,
    toString(max(last_seen_unix_milli)) AS lastSeenMs
  FROM metric_series
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
		query: `SELECT * EXCEPT(monotonic_state, temporal), monotonic_state AS monotonic, temporal AS temporality FROM (${METRICS}
  GROUP BY name, kind, temporal, monotonic_state, unit
  ORDER BY name, max(last_seen_unix_milli) DESC
  LIMIT ${MAX_METRICS})`,
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
		query: `SELECT * EXCEPT(monotonic_state, temporal), monotonic_state AS monotonic, temporal AS temporality FROM (${METRICS} AND metric_name IN {metrics:Array(String)}
  GROUP BY name, kind, temporal, monotonic_state, unit
  ORDER BY max(last_seen_unix_milli) DESC
  LIMIT 1 BY name)`,
		format: "JSONEachRow",
		query_params: { project: projectId, metrics: [...new Set(metrics)] },
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return new Map(
		(await result.json<MetricRow>()).map((row) => [row.name, definition(row)]),
	);
}

const attributeSource = (allMetrics: boolean) => `
  SELECT metric_name, last_seen_unix_milli, entry.1 AS scope,
    substring(entry.2, 2) AS attribute_key, toUInt8(entry.3) AS value_kind
  FROM metric_series
  ARRAY JOIN arrayConcat(
    arrayMap(a -> tuple('point', a.path, a.kind), point_attributes),
    arrayMap(a -> tuple('resource', a.path, a.kind), resource_attributes)
  ) AS entry
  WHERE project_id = {project:String}${allMetrics ? "" : " AND metric_name = {metric:String}"}
    AND value_kind BETWEEN 2 AND 6 AND position(attribute_key, '/') = 0`;

/** Attribute keys seen on one metric, for grouping and filtering choices. */
export async function listAttributes(
	connection: ClickHouseClient,
	projectId: string,
	metric?: string,
	signal?: AbortSignal,
): Promise<AttributeDefinition[]> {
	const result = await connection.query({
		query: `SELECT ${metric === undefined ? "''" : "metric_name"} AS metric, scope, attribute_key AS key, value_kind AS kind
  FROM (${attributeSource(metric === undefined)})
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
	lastSeenMs: string;
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
    toString(max(last_seen_unix_milli)) AS lastSeenMs,
    arraySort(groupUniqArray(${MAX_ATTRIBUTE_METRICS})(metric_name)) AS metrics
  FROM (${attributeSource(metric === undefined)})
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
	return (await result.json<AttributeRow>()).map(({ lastSeenMs, ...row }) => ({
		...row,
		lastSeen: millisecondsDate(lastSeenMs),
	}));
}

/** Examples come from a bounded sample of the metric's series active in the last hour. */
const EXAMPLE_WINDOW_MS = 3_600_000;
const EXAMPLE_SERIES = 2000;

/**
 * One recent value for each attribute of a metric, as text, keyed by `scope/key`.
 * The sample stops after a bounded number of series, so a busy metric still answers.
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
    FROM metric_series FINAL
    WHERE project_id = {project:String} AND metric_name = {metric:String}
      AND ${seriesLastSeen("{from:UInt64}")}
    LIMIT ${EXAMPLE_SERIES}
  )
  ARRAY JOIN arrayConcat(${value("point")}, ${value("resource")}) AS entry
  GROUP BY scope, key
  LIMIT ${MAX_ATTRIBUTES}`,
		format: "JSONEachRow",
		query_params: {
			project: projectId,
			metric,
			from: String(BigInt(from)),
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
 * The most frequent values of one attribute in a bounded sample of recent series from
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
	const points = seriesPointSource(
		` AND metric_name IN {metrics:Array(String)} AND ${seriesLastSeen("{from:UInt64}")}`,
		"AND event_day >= {firstDay:UInt32} AND time_unix_milli >= {from:UInt64}",
		"s.suggested",
		"",
		[`${column} AS suggested`],
	);
	const result = await connection.query({
		query: `SELECT value FROM (
    SELECT arrayJoin(arrayMap(a -> coalesce(a.string_value, toString(a.int_value), toString(a.double_value), if(a.bool_value = 1, 'true', 'false')),
      arrayFilter(a -> a.path = {path:String} AND a.kind BETWEEN 2 AND 5, suggested))) AS value
    FROM (
      SELECT suggested FROM (${points})
      LIMIT ${EXAMPLE_SERIES}
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
			from: String(BigInt(from)),
		},
		abort_signal: signal,
		clickhouse_settings: SETTINGS,
	});
	return (await result.json<{ value: string }>()).map((row) => row.value);
}

/** Suggested values come from points in the last day, most frequent first. */
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
	const onPoint = isPointField(field);
	const points = seriesPointSource(
		` AND ${seriesLastSeen("{from:UInt64}")}${metric === undefined ? "" : " AND metric_name = {metric:String}"}`,
		"AND event_day >= {firstDay:UInt32} AND time_unix_milli >= {from:UInt64}",
		onPoint ? "" : "s.suggested",
		"",
		onPoint ? [] : [`${value} AS suggested`],
	);
	const result = await connection.query({
		query: `SELECT ${onPoint ? value : "suggested"} AS value FROM (${points})
  WHERE value IS NOT NULL AND value != ''
  GROUP BY value
  ORDER BY count() DESC, value
  LIMIT ${MAX_VALUE_SUGGESTIONS}`,
		format: "JSONEachRow",
		query_params: {
			...params,
			project: projectId,
			firstDay: Math.floor(from / 86_400_000),
			from: BigInt(from).toString(),
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
