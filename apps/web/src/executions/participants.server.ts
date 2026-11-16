import type { ClickHouseClient } from "@clickhouse/client";
import { analyticsError } from "../analytics/runner.server";
import type { ExecutionFact } from "./contracts";
import { getTelemetryClient } from "./telemetry.server";

interface Row {
	executionKey: string;
	name: string;
	workloadVersion: string | null;
	parameters: [string, string][];
	nodeCount: number;
	participantCount: number;
	environmentVariables: string[];
	firstSeenNs: string;
	lastSeenNs: string;
}

const SETTINGS = {
	max_execution_time: 6,
	max_threads: 1,
	max_memory_usage: "268435456",
	max_rows_to_read: "100000",
	max_bytes_to_read: "268435456",
	read_overflow_mode: "throw",
	max_rows_to_group_by: "100000",
	group_by_overflow_mode: "throw",
	max_bytes_before_external_group_by: "0",
	max_bytes_before_external_sort: "0",
	max_result_bytes: "8388608",
	result_overflow_mode: "throw",
	output_format_json_quote_64bit_integers: 1,
} as const;

export async function readExecutions(
	projectId: string,
	selector: { executionKey?: string; afterKey?: string } = {},
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
) {
	try {
		const result = await connection.query({
			query: `SELECT execution_key AS executionKey,
  ifNull(metadata.1, execution_key) AS name, metadata.2 AS workloadVersion,
  arrayMap(p -> tuple(p.key,p.value), metadata.3) AS parameters,
  nodeCount,participantCount,environmentVariables,firstSeenNs,lastSeenNs
FROM (
  SELECT execution_key,
    toUInt32(uniqExact(node_id)) AS nodeCount,
    toUInt32(uniqExact(tuple(node_id,participant_id))) AS participantCount,
    arraySort(groupUniqArray(environment_variable)) AS environmentVariables,
    toString(min(first_seen_unix_nano)) AS firstSeenNs,
    toString(max(last_seen_unix_nano)) AS lastSeenNs,
    argMinIf(tuple(execution_name,workload_version,parameters),
      tuple(first_seen_unix_nano,node_id,fact_id),kind=1) AS metadata
  FROM (
    SELECT * FROM execution_participants FINAL
    WHERE project_id={project:String}
      AND ({key:String}='' OR execution_key={key:String})
      AND execution_key>{after:String}
  )
  WHERE NOT retracted GROUP BY execution_key
)
ORDER BY execution_key LIMIT 51`,
			format: "JSONEachRow",
			query_params: {
				project: projectId,
				key: selector.executionKey ?? "",
				after: selector.afterKey ?? "",
			},
			abort_signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10000)])
				: AbortSignal.timeout(10000),
			clickhouse_settings: {
				...SETTINGS,
				max_result_rows: "51",
			},
		});
		return (await result.json<Row>()).map((row) => ({
			executionKey: row.executionKey,
			name: row.name,
			workloadVersion: row.workloadVersion,
			parameters: Object.fromEntries(row.parameters),
			nodeCount: row.nodeCount,
			participantCount: row.participantCount,
			environmentVariables: row.environmentVariables,
			firstSeen: new Date(Number(BigInt(row.firstSeenNs) / 1_000_000n)),
			lastSeen: new Date(Number(BigInt(row.lastSeenNs) / 1_000_000n)),
		}));
	} catch (error) {
		return analyticsError(error, signal);
	}
}

const date = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n));

export async function readExecutionFacts(
	projectId: string,
	executionKey: string,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<ExecutionFact[]> {
	try {
		const result = await connection.query({
			query: `SELECT node_id AS nodeId, participant_id AS participantId, fact_id AS factId, kind,
  process_resource_id AS processResourceId, process_namespace_id AS namespaceId,
  process_pid AS pid, toString(process_start_time_ticks) AS startTimeTicks,
  owner_uid AS ownerUid, environment_variable AS environmentVariable,
  toString(first_seen_unix_nano) AS firstSeenNs, toString(last_seen_unix_nano) AS lastSeenNs,
  toString(ended_unix_nano) AS endedNs
FROM (
  SELECT * FROM execution_participants FINAL
  WHERE project_id={project:String} AND execution_key={key:String}
)
WHERE NOT retracted
ORDER BY node_id, participant_id, kind, first_seen_unix_nano, fact_id`,
			query_params: { project: projectId, key: executionKey },
			format: "JSONEachRow",
			abort_signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10000)])
				: AbortSignal.timeout(10000),
			// Never silently truncate a node's membership list.
			clickhouse_settings: { ...SETTINGS, max_result_rows: "1000" },
		});
		type FactRow = Omit<ExecutionFact, "firstSeen" | "lastSeen" | "ended"> & {
			firstSeenNs: string;
			lastSeenNs: string;
			endedNs: string | null;
		};
		return (await result.json<FactRow>()).map(
			({ firstSeenNs, lastSeenNs, endedNs, ...fact }) => ({
				...fact,
				firstSeen: date(firstSeenNs),
				lastSeen: date(lastSeenNs),
				ended: endedNs === null ? null : date(endedNs),
			}),
		);
	} catch (error) {
		return analyticsError(error, signal);
	}
}
