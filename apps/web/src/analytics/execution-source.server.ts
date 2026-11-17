import type { ClickHouseClient, ClickHouseSettings } from "@clickhouse/client";

/**
 * One joined row per point resource. Intervals are tested as a set, never joined
 * individually: repeated and overlapping facts cannot multiply measurements.
 * Callers supply project/time-predicated points and enforce their usual read caps.
 */
export function executionPointSource(points: string) {
	return `(SELECT points.*, arraySort(arrayDistinct(arrayMap(m -> m.1,
    arrayFilter(m -> resource_kind = 4 AND time_unix_nano >= m.2 AND
      if(m.4 = 0, time_unix_nano <= m.3, time_unix_nano < m.4), memberships)))) AS execution_keys
  FROM (${points}) AS points
  LEFT JOIN (
    SELECT node_id AS membership_node, assumeNotNull(process_resource_id) AS membership_resource,
      groupArray(tuple(execution_key, first_seen_unix_nano, last_seen_unix_nano,
        ifNull(ended_unix_nano, toUInt64(0)))) AS memberships
    FROM (
      SELECT * FROM execution_participants FINAL WHERE project_id = {project:String}
    )
    WHERE NOT retracted AND kind = 2 AND process_resource_id IS NOT NULL
      AND first_seen_unix_nano < {to:UInt64}
      AND if(isNull(ended_unix_nano), last_seen_unix_nano >= {from:UInt64}, ended_unix_nano > {from:UInt64})
    GROUP BY membership_node, membership_resource
  ) AS membership_sets
  ON points.source_id = membership_node AND points.resource_id = membership_resource)`;
}

/**
 * The periods of a project's executions, from the earliest first sighting of any of
 * their nonretracted facts to the latest end, or last sighting of a fact without one.
 * Keys without facts in the project are absent.
 */
export async function executionPeriods(
	connection: ClickHouseClient,
	projectId: string,
	keys: string[],
	signal: AbortSignal,
	settings: ClickHouseSettings,
): Promise<Map<string, { from: Date; to: Date }>> {
	const result = await connection.query({
		query: `SELECT execution_key AS key, toString(min(first_seen_unix_nano)) AS fromNs,
  toString(max(ifNull(ended_unix_nano, last_seen_unix_nano))) AS toNs
FROM (
  SELECT * FROM execution_participants FINAL
  WHERE project_id = {project:String} AND execution_key IN {keys:Array(String)}
)
WHERE NOT retracted
GROUP BY execution_key`,
		format: "JSONEachRow",
		query_params: { project: projectId, keys },
		abort_signal: signal,
		clickhouse_settings: settings,
	});
	const rows = await result.json<{
		key: string;
		fromNs: string;
		toNs: string;
	}>();
	const date = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n));
	return new Map(
		rows.map((row) => [
			row.key,
			{ from: date(row.fromNs), to: date(row.toNs) },
		]),
	);
}
