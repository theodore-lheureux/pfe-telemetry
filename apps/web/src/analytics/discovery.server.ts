import type { ClickHouseClient } from "@clickhouse/client";
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
	lastSeenNs: string;
}

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
		lastSeen: new Date(Number(BigInt(row.lastSeenNs) / 1_000_000n)),
	};
}

const METRICS = `SELECT metric_name AS name, metric_kind AS kind, temporality,
    monotonic_state AS monotonic, unit, anyLast(description) AS description,
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
