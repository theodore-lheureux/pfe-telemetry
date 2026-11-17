import type { ClickHouseClient } from "@clickhouse/client";
import { analyticsError } from "../analytics/runner.server";
import { OVERLAP_LIMIT, OVERLAP_NODE_LIMIT } from "./overlaps";
import {
	getTelemetryClient,
	nanosecondDate,
	PARTICIPANT_READ_SETTINGS,
	readDeadline,
} from "./telemetry.server";

// Participant intervals are half-open [first seen, end): an explicit end is exclusive,
// while the last observation of an open participant is included.
const INTERVAL = `min(first_seen_unix_nano) AS f,
    max(if(isNull(ended_unix_nano), last_seen_unix_nano + 1, ended_unix_nano)) AS l`;

/** The selected execution's nodes and their active spans, sorted by node. */
export async function readExecutionSpans(
	projectId: string,
	executionKey: string,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
) {
	try {
		const result = await connection.query({
			query: `SELECT node_id AS nodeId, toString(min(f)) AS fromNs, toString(max(l)) AS toNs
FROM (
  SELECT node_id, participant_id, ${INTERVAL}
  FROM (
    SELECT * FROM execution_participants FINAL
    WHERE project_id = {project:String} AND execution_key = {key:String}
  )
  WHERE NOT retracted
  GROUP BY node_id, participant_id
)
GROUP BY node_id ORDER BY node_id`,
			query_params: { project: projectId, key: executionKey },
			format: "JSONEachRow",
			abort_signal: readDeadline(signal),
			// Never silently drop one of the execution's nodes.
			clickhouse_settings: {
				...PARTICIPANT_READ_SETTINGS,
				max_result_rows: "1000",
			},
		});
		const rows = await result.json<{
			nodeId: string;
			fromNs: string;
			toNs: string;
		}>();
		return rows.map((row) => ({
			nodeId: row.nodeId,
			from: nanosecondDate(row.fromNs),
			to: nanosecondDate(row.toNs),
		}));
	} catch (error) {
		return analyticsError(error, signal);
	}
}

interface OverlapRow {
	executionKey: string;
	name: string;
	workloadVersion: string | null;
	nodeCount: number;
	nodes: string[];
	fromNs: string;
	toNs: string;
}

/**
 * The project's other executions with a participant on one of the selected execution's
 * nodes while one of its participants there was active, earliest overlap first. The
 * project's facts are read once: each participant sees the selected execution's
 * participants on its node through a window, and metadata comes from the same rows.
 */
export async function readOverlappingExecutions(
	projectId: string,
	executionKey: string,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
) {
	try {
		const result = await connection.query({
			query: `WITH participants AS (
  SELECT execution_key, node_id, ${INTERVAL},
    argMinIf(tuple(execution_name, workload_version),
      tuple(first_seen_unix_nano, node_id, fact_id), kind = 1) AS meta,
    minIf(tuple(first_seen_unix_nano, node_id, fact_id), kind = 1) AS meta_order,
    countIf(kind = 1) > 0 AS has_meta
  FROM (
    SELECT * FROM execution_participants FINAL WHERE project_id = {project:String}
  )
  WHERE NOT retracted
  GROUP BY execution_key, node_id, participant_id
),
overlaps AS (
  SELECT execution_key, node_id, meta, meta_order, has_meta,
    arrayMap(s -> tuple(greatest(f, s.1), least(l, s.2)),
      arrayFilter(s -> greatest(f, s.1) < least(l, s.2),
        groupArrayIf(tuple(f, l), execution_key = {key:String})
          OVER (PARTITION BY node_id))) AS shared
  FROM participants
),
nodes AS (
  SELECT execution_key, node_id,
    argMinIf(meta, meta_order, has_meta) AS node_meta,
    minIf(meta_order, has_meta) AS node_meta_order, max(has_meta) AS node_has_meta,
    notEmpty(groupArrayArray(shared)) AS overlapping,
    arrayMin(arrayMap(s -> s.1, groupArrayArray(shared))) AS first,
    arrayMax(arrayMap(s -> s.2, groupArrayArray(shared))) AS last
  FROM overlaps WHERE execution_key != {key:String}
  GROUP BY execution_key, node_id
)
SELECT execution_key AS executionKey,
  argMinIf(node_meta, node_meta_order, node_has_meta) AS meta,
  ifNull(meta.1, execution_key) AS name, meta.2 AS workloadVersion,
  toUInt32(countIf(overlapping)) AS nodeCount,
  arraySlice(arraySort(groupArrayIf(node_id, overlapping)), 1, {nodeLimit:UInt32}) AS nodes,
  toString(minIf(first, overlapping)) AS fromNs,
  toString(maxIf(last, overlapping)) AS toNs
FROM nodes GROUP BY execution_key HAVING nodeCount > 0
ORDER BY minIf(first, overlapping), executionKey LIMIT {limit:UInt32}`,
			query_params: {
				project: projectId,
				key: executionKey,
				limit: OVERLAP_LIMIT + 1,
				nodeLimit: OVERLAP_NODE_LIMIT,
			},
			format: "JSONEachRow",
			abort_signal: readDeadline(signal),
			clickhouse_settings: {
				...PARTICIPANT_READ_SETTINGS,
				max_result_rows: String(OVERLAP_LIMIT + 1),
			},
		});
		const rows = await result.json<OverlapRow>();
		return {
			executions: rows.slice(0, OVERLAP_LIMIT).map((row) => ({
				executionKey: row.executionKey,
				name: row.name,
				workloadVersion: row.workloadVersion,
				nodeCount: row.nodeCount,
				nodeIds: row.nodes,
				from: nanosecondDate(row.fromNs),
				to: nanosecondDate(row.toNs),
			})),
			more: rows.length > OVERLAP_LIMIT,
		};
	} catch (error) {
		return analyticsError(error, signal);
	}
}
