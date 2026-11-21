import { getTelemetryClient } from "../executions/telemetry.server";
import { OperationError } from "../lib/operation-error";
import type { ProjectReference } from "../organizations/contracts";
import { nanosecondsDate } from "./codec.server";

export async function readRejectedDeliveries(
	input: ProjectReference,
	signal?: AbortSignal,
	connection = getTelemetryClient(),
) {
	try {
		const response = await connection.query({
			query: `SELECT raw_topic, raw_partition, raw_offset,
				argMax(source_id, rejected_unix_nano) AS source,
				argMax(received_unix_nano, rejected_unix_nano) AS received,
				argMax(reason, rejected_unix_nano) AS rejection_reason
				FROM project_rejected_deliveries
				WHERE project_id = {project:String}
				GROUP BY raw_topic, raw_partition, raw_offset
				ORDER BY received DESC, raw_topic, raw_partition, raw_offset DESC
				LIMIT 50`,
			query_params: { project: input.projectId },
			format: "JSONEachRow",
			abort_signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10000)])
				: AbortSignal.timeout(10000),
			clickhouse_settings: {
				max_execution_time: 6,
				max_threads: 1,
				max_memory_usage: "67108864",
				output_format_json_quote_64bit_integers: 1,
			},
		});
		const rows = await response.json<{
			raw_topic: string;
			raw_partition: number;
			raw_offset: string;
			source: string;
			received: string;
			rejection_reason: string;
		}>();
		return rows.map((row) => ({
			id: `${row.raw_topic}/${row.raw_partition}/${row.raw_offset}`,
			source: row.source,
			received: nanosecondsDate(row.received),
			reason: row.rejection_reason,
		}));
	} catch {
		if (signal?.aborted)
			throw new OperationError("CANCELLED", "Activity query cancelled");
		throw new OperationError(
			"UNAVAILABLE",
			"Rejected deliveries are unavailable",
		);
	}
}
