import { withAnalyticsSlot } from "../analytics/capacity.server";
import type { getDatabase } from "../db/client.server";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import type { ExecutionReference, ExecutionSummary } from "./contracts";
import { readExecutions } from "./participants.server";

type Database = ReturnType<typeof getDatabase>;
export async function listExecutions(
	database: Database,
	actor: Actor,
	input: ProjectReference & { afterKey?: string },
	signal?: AbortSignal,
	read: typeof readExecutions = readExecutions,
) {
	await requireProject(database, actor, input);
	const entries = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		() => read(input.projectId, { afterKey: input.afterKey }, signal),
	);
	return {
		executions: entries.slice(0, 50).map(
			(entry): ExecutionSummary => ({
				organizationId: input.organizationId,
				projectId: input.projectId,
				...entry,
			}),
		),
		nextCursor: entries.length > 50 ? entries[49].executionKey : null,
	};
}
export async function getExecution(
	database: Database,
	actor: Actor,
	input: ExecutionReference,
	signal?: AbortSignal,
	read: typeof readExecutions = readExecutions,
): Promise<ExecutionSummary> {
	await requireProject(database, actor, input);
	const [entry] = await withAnalyticsSlot(
		database,
		input.organizationId,
		signal,
		() => read(input.projectId, { executionKey: input.executionKey }, signal),
	);
	if (!entry) throw new OperationError("NOT_FOUND", "Execution not found");
	return { ...input, ...entry };
}
