import { and, desc, eq, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { withAnalyticsSlot } from "../analytics/capacity.server";
import { listSourceNodes } from "../collectors/collectors.server";
import type { getDatabase } from "../db/client.server";
import { collectorNode } from "../db/collectors-schema";
import { execution } from "../db/executions-schema";
import { createOnce } from "../lib/create-once.server";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference, ProjectRole } from "../organizations/contracts";
import type {
	CreateExecutionInput,
	ExecutionReference,
	ExecutionSummary,
	TelemetryInput,
} from "./contracts";
import { readTelemetry, type TelemetryScope } from "./telemetry.server";
import { parseCreateExecution } from "./validation";

type Database = ReturnType<typeof getDatabase>;
type Entry = typeof execution.$inferSelect;
function editable(entry: Entry, actor: Actor, role: ProjectRole) {
	return (
		role === "admin" || (role === "member" && entry.createdBy === actor.id)
	);
}
function summary(
	entry: Entry,
	actor: Actor,
	role: ProjectRole,
): ExecutionSummary {
	const { id, ...fields } = entry;
	return { ...fields, executionId: id, canEdit: editable(entry, actor, role) };
}
function tenant(reference: ProjectReference) {
	return and(
		eq(execution.organizationId, reference.organizationId),
		eq(execution.projectId, reference.projectId),
	);
}
async function find(
	database: Pick<Database, "select">,
	reference: ExecutionReference,
) {
	const [entry] = await database
		.select()
		.from(execution)
		.where(and(tenant(reference), eq(execution.id, reference.executionId)));
	if (!entry) throw new OperationError("NOT_FOUND", "Execution not found");
	return entry;
}
function writer(role: ProjectRole) {
	if (role === "viewer")
		throw new OperationError("FORBIDDEN", "Project member access required");
}
export async function listExecutions(
	database: Database,
	actor: Actor,
	input: ProjectReference & { beforeId?: string },
) {
	const access = await requireProject(database, actor, input);
	if (input.beforeId)
		await find(database, { ...input, executionId: input.beforeId });
	const entries = await database
		.select()
		.from(execution)
		.where(
			and(
				tenant(input),
				input.beforeId ? lt(execution.id, input.beforeId) : undefined,
			),
		)
		.orderBy(desc(execution.id))
		.limit(51);
	return {
		executions: entries
			.slice(0, 50)
			.map((entry) => summary(entry, actor, access.role)),
		nextCursor: entries.length > 50 ? entries[49].id : null,
		canCreate: access.role !== "viewer",
	};
}
export async function listExecutionSources(
	database: Database,
	actor: Actor,
	input: ProjectReference,
) {
	const access = await requireProject(database, actor, input);
	writer(access.role);
	const sources = await listSourceNodes(database, {
		organizationId: access.organizationId,
		projectId: access.id,
	});
	if (sources.length > 200)
		throw new OperationError("CAPACITY", "Too many source choices");
	return sources;
}
export async function getExecution(
	database: Pick<Database, "select">,
	actor: Actor,
	input: ExecutionReference,
) {
	const access = await requireProject(database, actor, input);
	return summary(await find(database, input), actor, access.role);
}
export async function createExecution(
	database: Database,
	actor: Actor,
	input: CreateExecutionInput,
) {
	input = parseCreateExecution(input);
	return createOnce(database, {
		actorId: actor.id,
		scope: {
			operation: "create-execution",
			organizationId: input.organizationId,
			projectId: input.projectId,
		},
		submission: input,
		resourceId: uuidv7(),
		authorize: async (tx) => {
			const access = await requireProject(tx, actor, input);
			writer(access.role);
			return access;
		},
		create: async (tx, id, access) => {
			const [source] = await tx
				.select({ sourceId: collectorNode.id })
				.from(collectorNode)
				.where(
					and(
						eq(collectorNode.id, input.nodeId),
						eq(collectorNode.projectId, access.id),
						eq(collectorNode.organizationId, access.organizationId),
					),
				);
			if (!source)
				throw new OperationError("NOT_FOUND", "Collector source not found");
			await tx.insert(execution).values({
				id,
				organizationId: access.organizationId,
				projectId: access.id,
				sourceId: source.sourceId,
				hostId: input.hostId,
				name: input.name,
				startedAt: new Date(input.startedAt),
				endedAt: new Date(input.endedAt),
				createdBy: actor.id,
			});
		},
		read: (tx, executionId) =>
			getExecution(tx, actor, { ...input, executionId }),
	});
}
export async function updateExecution(
	database: Database,
	actor: Actor,
	input: ExecutionReference & { name: string },
) {
	const access = await requireProject(database, actor, input);
	const entry = await find(database, input);
	if (!editable(entry, actor, access.role))
		throw new OperationError(
			"FORBIDDEN",
			"Execution creator or project administrator required",
		);
	const [updated] = await database
		.update(execution)
		.set({ name: input.name })
		.where(and(tenant(input), eq(execution.id, entry.id)))
		.returning();
	if (!updated) throw new OperationError("NOT_FOUND", "Execution not found");
	return summary(updated, actor, access.role);
}
export async function queryExecutionTelemetry(
	database: Database,
	actor: Actor,
	input: TelemetryInput,
	signal?: AbortSignal,
	read: (
		scope: TelemetryScope,
		signal?: AbortSignal,
	) => ReturnType<typeof readTelemetry> = readTelemetry,
) {
	await requireProject(database, actor, input);
	const entry = await find(database, input);
	const from = input.from ? new Date(input.from) : entry.startedAt;
	const to = input.to
		? new Date(input.to)
		: new Date(Math.min(entry.endedAt.getTime(), from.getTime() + 300000));
	const duration = to.getTime() - from.getTime();
	const buckets = input.buckets ?? 300;
	if (
		!Number.isFinite(duration) ||
		from < entry.startedAt ||
		to > entry.endedAt ||
		duration <= 0 ||
		duration > 86400000 ||
		!Number.isInteger(buckets) ||
		buckets < 1 ||
		buckets > 600
	)
		throw new OperationError(
			"INVALID_INPUT",
			"Select an interval within the recording, at most 24 hours",
			"INVALID_TIME_RANGE",
		);
	return withAnalyticsSlot(database, input.organizationId, signal, () =>
		read(
			{
				projectId: entry.projectId,
				sourceId: entry.sourceId,
				hostId: entry.hostId,
				from,
				to,
				buckets,
			},
			signal,
		),
	);
}
