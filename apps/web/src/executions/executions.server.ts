import { and, eq, inArray, isNull } from "drizzle-orm";
import { withAnalyticsSlot } from "../analytics/capacity.server";
import type { getDatabase } from "../db/client.server";
import { collectorNode } from "../db/schema";
import { isUuid } from "../lib/input";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import type {
	ExecutionDetail,
	ExecutionFilterOptions,
	ExecutionListInput,
	ExecutionNode,
	ExecutionPage,
	ExecutionReference,
	ExecutionSummary,
} from "./contracts";
import {
	readExecutionFacts,
	readExecutionFilterOptions,
	readExecutions,
} from "./participants.server";

type Database = ReturnType<typeof getDatabase>;

/** Enrolled hostnames for node IDs in the project; deleted nodes have none. */
async function nodesFor(
	database: Database,
	input: ProjectReference,
	ids: string[],
): Promise<ExecutionNode[]> {
	const unique = [...new Set(ids)];
	const enrolled = unique.filter(isUuid);
	const rows = enrolled.length
		? await database
				.select({ id: collectorNode.id, hostname: collectorNode.hostname })
				.from(collectorNode)
				.where(
					and(
						eq(collectorNode.projectId, input.projectId),
						eq(collectorNode.organizationId, input.organizationId),
						isNull(collectorNode.deletedAt),
						inArray(collectorNode.id, enrolled),
					),
				)
		: [];
	const names = new Map(rows.map((row) => [row.id, row.hostname]));
	return unique.map((id) => ({ id, hostname: names.get(id) ?? null }));
}

export async function listExecutions(
	database: Database,
	actor: Actor,
	input: ExecutionListInput,
	signal?: AbortSignal,
	read: typeof readExecutions = readExecutions,
): Promise<ExecutionPage> {
	await requireProject(database, actor, input);
	const { organizationId, projectId, afterKey, ...filters } = input;
	const entries = await withAnalyticsSlot(
		database,
		organizationId,
		signal,
		() => read(projectId, { afterKey, filters }, signal),
	);
	const executions = entries
		.slice(0, 50)
		.map(
			(entry): ExecutionSummary => ({ organizationId, projectId, ...entry }),
		);
	return {
		executions,
		nextCursor: entries.length > 50 ? entries[49].executionKey : null,
		nodes: await nodesFor(
			database,
			input,
			executions.flatMap((entry) => entry.nodeIds),
		),
	};
}

export async function listExecutionFilterOptions(
	database: Database,
	actor: Actor,
	input: ProjectReference,
	signal?: AbortSignal,
	read: typeof readExecutionFilterOptions = readExecutionFilterOptions,
): Promise<ExecutionFilterOptions> {
	await requireProject(database, actor, input);
	const options = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		() => read(input.projectId, signal),
	);
	return {
		applications: options.applications,
		// Participant node IDs are enrolled node UUIDs; the machine filter accepts only those.
		machines: await nodesFor(database, input, options.machines.filter(isUuid)),
		owners: options.owners,
	};
}
export async function getExecution(
	database: Database,
	actor: Actor,
	input: ExecutionReference,
	signal?: AbortSignal,
	read: typeof readExecutions = readExecutions,
	readFacts: typeof readExecutionFacts = readExecutionFacts,
): Promise<ExecutionDetail> {
	await requireProject(database, actor, input);
	return withAnalyticsSlot(database, input.organizationId, signal, async () => {
		const [entry] = await read(
			input.projectId,
			{ executionKey: input.executionKey },
			signal,
		);
		if (!entry) throw new OperationError("NOT_FOUND", "Execution not found");
		const facts = await readFacts(input.projectId, input.executionKey, signal);
		return { ...input, ...entry, facts };
	});
}
