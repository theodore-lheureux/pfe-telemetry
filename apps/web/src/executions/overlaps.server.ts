import { nodeNames } from "../analytics/analytics.server";
import { withAnalyticsSlot } from "../analytics/capacity.server";
import type { getDatabase } from "../db/client.server";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ExecutionReference } from "./contracts";
import { readExecutionLoad } from "./overlap-load.server";
import {
	readExecutionSpans,
	readOverlappingExecutions,
} from "./overlap-reads.server";
import type { ExecutionLoad, ExecutionOverlaps } from "./overlaps";

type Database = ReturnType<typeof getDatabase>;

export interface OverlapReaders {
	spans: typeof readExecutionSpans;
	overlaps: typeof readOverlappingExecutions;
	load: typeof readExecutionLoad;
}
const readers: OverlapReaders = {
	spans: readExecutionSpans,
	overlaps: readOverlappingExecutions,
	load: readExecutionLoad,
};

async function requireSpans(
	read: OverlapReaders,
	input: ExecutionReference,
	signal?: AbortSignal,
) {
	const spans = await read.spans(input.projectId, input.executionKey, signal);
	if (!spans.length)
		throw new OperationError("NOT_FOUND", "Execution not found");
	return spans;
}

/** The project's executions sharing a node and time with the selected one. */
export async function getExecutionOverlaps(
	database: Database,
	actor: Actor,
	input: ExecutionReference,
	signal?: AbortSignal,
	read: OverlapReaders = readers,
): Promise<ExecutionOverlaps> {
	await requireProject(database, actor, input);
	const overlaps = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		async () => {
			await requireSpans(read, input, signal);
			return read.overlaps(input.projectId, input.executionKey, signal);
		},
	);
	const hostnames = new Map(
		(await nodeNames(database, input)).map((node) => [node.id, node.hostname]),
	);
	return {
		more: overlaps.more,
		executions: overlaps.executions.map(({ nodeIds, ...execution }) => ({
			...execution,
			nodes: nodeIds.map((nodeId) => ({
				nodeId,
				hostname: hostnames.get(nodeId) ?? null,
			})),
		})),
	};
}

/** The selected execution's nodes' process load, split by workload within the project. */
export async function getExecutionLoad(
	database: Database,
	actor: Actor,
	input: ExecutionReference,
	signal?: AbortSignal,
	read: OverlapReaders = readers,
): Promise<ExecutionLoad> {
	await requireProject(database, actor, input);
	return withAnalyticsSlot(database, input.organizationId, signal, async () =>
		read.load(
			input.projectId,
			input.executionKey,
			await requireSpans(read, input, signal),
			signal,
		),
	);
}
