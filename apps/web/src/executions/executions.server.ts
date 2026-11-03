import { and, desc, eq, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { getDatabase } from "../db/client.server";
import { collectorCredential } from "../db/credentials-schema";
import { execution } from "../db/executions-schema";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference, ProjectRole } from "../organizations/contracts";
import { OperationError } from "../organizations/errors";
import type {
	CreateExecutionInput,
	ExecutionReference,
	ExecutionSummary,
	TelemetryInput,
} from "./contracts";
import { readTelemetry, type TelemetryScope } from "./telemetry.server";

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
async function find(database: Database, reference: ExecutionReference) {
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
	const sources = await database
		.select({
			credentialId: collectorCredential.id,
			name: collectorCredential.name,
			sourceId: collectorCredential.sourceId,
		})
		.from(collectorCredential)
		.where(
			and(
				eq(collectorCredential.organizationId, access.organizationId),
				eq(collectorCredential.projectId, access.id),
			),
		)
		.orderBy(desc(collectorCredential.createdAt))
		.limit(201);
	if (sources.length > 200)
		throw new OperationError("CAPACITY", "Too many source choices");
	return sources;
}
export async function getExecution(
	database: Database,
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
	const access = await requireProject(database, actor, input);
	writer(access.role);
	const [source] = await database
		.select({ sourceId: collectorCredential.sourceId })
		.from(collectorCredential)
		.where(
			and(
				eq(collectorCredential.id, input.credentialId),
				eq(collectorCredential.projectId, access.id),
				eq(collectorCredential.organizationId, access.organizationId),
			),
		);
	if (!source)
		throw new OperationError("NOT_FOUND", "Collector source not found");
	const [entry] = await database
		.insert(execution)
		.values({
			id: uuidv7(),
			organizationId: access.organizationId,
			projectId: access.id,
			sourceId: source.sourceId,
			hostId: input.hostId,
			name: input.name,
			startedAt: new Date(input.startedAt),
			endedAt: new Date(input.endedAt),
			createdBy: actor.id,
		})
		.returning();
	return summary(entry, actor, access.role);
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
	return read(
		{
			projectId: entry.projectId,
			sourceId: entry.sourceId,
			hostId: entry.hostId,
			from,
			to,
			buckets,
		},
		signal,
	);
}
