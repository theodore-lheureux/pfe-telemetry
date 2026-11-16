import { randomUUID } from "node:crypto";

export function executionParticipant(
	projectId: string,
	executionKey: string,
	options: { nodeId?: string; name?: string; firstSeen?: bigint } = {},
) {
	const id = randomUUID();
	const firstSeen = options.firstSeen ?? 1793700000000000000n;
	return {
		project_id: projectId,
		node_id: options.nodeId ?? randomUUID(),
		host_id: "fixture",
		boot_id: "01234567-89ab-cdef-0123-456789abcdef",
		execution_key: executionKey,
		participant_id: id,
		fact_id: id,
		revision: "1",
		kind: 1,
		origin: 1,
		environment_variable: "SLURM_JOB_ID",
		first_seen_unix_nano: firstSeen.toString(),
		last_seen_unix_nano: (firstSeen + 1000000000n).toString(),
		retracted: false,
		execution_name: options.name ?? "Distributed job",
		workload_version: "build-a",
		parameters: [
			{ key: "label", value: "<node>" },
			{ key: "size", value: "32" },
		],
		record_id: randomUUID(),
		received_unix_nano: firstSeen.toString(),
	};
}
