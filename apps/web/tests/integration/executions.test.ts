import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as collectorDomain from "../../src/collectors/collectors.server";
import { execution, member } from "../../src/db/schema";
import * as executionDomain from "../../src/executions/executions.server";
import { queryExecutionTelemetry } from "../../src/executions/executions.server";
import { parseCreateExecution } from "../../src/executions/validation";
import type { OperationResult } from "../../src/lib/operation-result";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestNode } from "../collector-node";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let requests: ReturnType<typeof actorService>;
let organizations: ReturnType<typeof actorService>;
const origin = "http://localhost:3001";
const codes = new Map<string, string>();
let count = 0;
function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}
async function actor() {
	const email = `execution-${++count}@example.invalid`;
	return trustedActor(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
}
beforeAll(async () => {
	database = await createTestDatabase("executions");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `execution-test-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	requests = actorService(auth);
	organizations = actorService(auth);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

async function scenario() {
	const owner = await actor();
	const writer = await actor();
	const viewer = await actor();
	const outsider = await actor();
	const organization = data(
		await organizations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Executions",
				slug: `executions-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Private",
			}),
		),
	);
	const other = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Other",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	for (const entry of [writer, viewer, outsider])
		await database.db.insert(member).values({
			id: randomUUID(),
			organizationId: organization.id,
			userId: entry.id,
			role: "member",
			createdAt: new Date(),
		});
	const memberships = await database.db
		.select()
		.from(member)
		.where(eq(member.organizationId, organization.id));
	for (const [entry, role] of [
		[writer, "member"],
		[viewer, "viewer"],
	] as const)
		data(
			await organizations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: memberships.find((item) => item.userId === entry.id)
						?.id as string,
					role,
				}),
			),
		);
	const { nodeId: sourceNodeId } = await createTestNode(database.db, reference);
	const otherSource = await createTestNode(
		database.db,
		{ organizationId: organization.id, projectId: other.id },
		{ hostname: "node2", machineId: "node2" },
	);
	const input = parseCreateExecution({
		requestId: crypto.randomUUID(),
		...reference,
		nodeId: sourceNodeId,
		name: "Recorded",
		hostId: "node1",
		startedAt: "2026-11-03T10:00:00Z",
		endedAt: "2026-11-03T11:00:00Z",
	});
	return {
		owner,
		writer,
		viewer,
		outsider,
		organization,
		project,
		other,
		reference,
		memberships,
		otherSource,
		sourceNodeId,
		input,
	};
}

async function recordedScenario() {
	const fixture = await scenario();
	const entry = data(
		await requests(fixture.writer.headers, (actor) =>
			executionDomain.createExecution(database.db, actor, fixture.input),
		),
	);
	return {
		...fixture,
		entry,
		ref: { ...fixture.reference, executionId: entry.executionId },
	};
}

test("canonical project access controls execution creation, project-wide reads and edits", async () => {
	const {
		sourceNodeId,
		owner,
		writer,
		viewer,
		outsider,
		organization,
		other,
		reference,
		otherSource,
		input,
	} = await scenario();
	expect(
		(
			await requests(viewer.headers, (actor) =>
				executionDomain.createExecution(database.db, actor, input),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await requests(writer.headers, (actor) =>
				executionDomain.createExecution(database.db, actor, {
					...input,
					nodeId: otherSource.nodeId,
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	const entry = data(
		await requests(writer.headers, (actor) =>
			executionDomain.createExecution(database.db, actor, input),
		),
	);
	const ref = { ...reference, executionId: entry.executionId };
	expect(entry.startedAt).toBeInstanceOf(Date);
	expect(
		data(
			await requests(viewer.headers, (actor) =>
				executionDomain.getExecution(database.db, actor, ref),
			),
		).name,
	).toBe("Recorded");
	expect(
		(
			await requests(viewer.headers, (actor) =>
				executionDomain.updateExecution(database.db, actor, {
					...ref,
					name: "No",
				}),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		data(
			await requests(owner.headers, (actor) =>
				executionDomain.updateExecution(database.db, actor, {
					...ref,
					name: "Renamed",
				}),
			),
		).sourceId,
	).toBe(sourceNodeId);
	const foreignRef = { ...ref, projectId: other.id };
	for (const headers of [outsider.headers, new Headers()]) {
		const expected =
			headers === outsider.headers ? "NOT_FOUND" : "UNAUTHENTICATED";
		const outcomes = await Promise.all([
			requests(headers, (actor) =>
				executionDomain.getExecution(database.db, actor, ref),
			),
			requests(headers, (actor) =>
				executionDomain.listExecutions(database.db, actor, {
					...reference,
					beforeId: ref.executionId,
				}),
			),
			requests(headers, (actor) =>
				executionDomain.listExecutionSources(database.db, actor, reference),
			),
			requests(headers, (actor) =>
				executionDomain.queryExecutionTelemetry(database.db, actor, {
					...ref,
					from: "2026-11-03T10:10:00Z",
				}),
			),
			requests(headers, (actor) =>
				executionDomain.createExecution(database.db, actor, input),
			),
			requests(headers, (actor) =>
				executionDomain.updateExecution(database.db, actor, {
					...ref,
					name: "No",
				}),
			),
		]);
		expect(outcomes.every((result) => result.error?.code === expected)).toBe(
			true,
		);
	}
	expect(
		(
			await requests(owner.headers, (actor) =>
				executionDomain.getExecution(database.db, actor, foreignRef),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await requests(owner.headers, (actor) =>
				executionDomain.listExecutions(database.db, actor, {
					organizationId: organization.id,
					projectId: other.id,
					beforeId: ref.executionId,
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
});

test("telemetry reads use authorized immutable recording scope and bounded intervals", async () => {
	const { viewer, project, other, ref, sourceNodeId } =
		await recordedScenario();
	const foreignRef = { ...ref, projectId: other.id };
	let scope: unknown;
	await queryExecutionTelemetry(
		database.db,
		viewer,
		{
			...ref,
			from: "2026-11-03T10:10:00Z",
			to: "2026-11-03T10:11:00Z",
			buckets: 60,
		},
		undefined,
		async (value) => {
			scope = value;
			return { from: value.from, to: value.to, bucketMs: 1000, series: [] };
		},
	);
	expect(scope).toEqual({
		projectId: project.id,
		sourceId: sourceNodeId,
		hostId: "node1",
		from: new Date("2026-11-03T10:10:00Z"),
		to: new Date("2026-11-03T10:11:00Z"),
		buckets: 60,
	});
	let foreignRead = false;
	await expect(
		queryExecutionTelemetry(
			database.db,
			viewer,
			foreignRef,
			undefined,
			async (value) => {
				foreignRead = true;
				return { from: value.from, to: value.to, bucketMs: 1000, series: [] };
			},
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(foreignRead).toBe(false);
	await expect(
		queryExecutionTelemetry(database.db, viewer, {
			...ref,
			from: "2026-11-03T09:59:00Z",
		}),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("source revocation preserves recordings while membership revocation removes access", async () => {
	const { owner, viewer, reference, memberships, ref, sourceNodeId } =
		await recordedScenario();
	data(
		await requests(owner.headers, (actor) =>
			collectorDomain.revokeNodes(database.db, actor, {
				...reference,
				nodeIds: [sourceNodeId],
			}),
		),
	);
	expect(
		data(
			await requests(viewer.headers, (actor) =>
				executionDomain.getExecution(database.db, actor, ref),
			),
		).sourceId,
	).toBe(sourceNodeId);
	data(
		await organizations(owner.headers, (actor) =>
			projectDomain.removeProjectMember(database.db, actor, {
				...reference,
				memberId: memberships.find((item) => item.userId === viewer.id)
					?.id as string,
			}),
		),
	);
	expect(
		(
			await requests(viewer.headers, (actor) =>
				executionDomain.queryExecutionTelemetry(database.db, actor, ref),
			)
		).error?.code,
	).toBe("NOT_FOUND");
});

test("execution pagination returns stable nonoverlapping project-scoped pages", async () => {
	const { viewer, organization, project, reference, entry, sourceNodeId } =
		await recordedScenario();
	const inserted = Array.from({ length: 51 }, () => ({
		id: uuidv7(),
		organizationId: organization.id,
		projectId: project.id,
		name: "Page",
		sourceId: sourceNodeId,
		startedAt: entry.startedAt,
		endedAt: entry.endedAt,
	}));
	await database.db.insert(execution).values(inserted);
	const first = data(
		await requests(viewer.headers, (actor) =>
			executionDomain.listExecutions(database.db, actor, reference),
		),
	);
	const second = data(
		await requests(viewer.headers, (actor) =>
			executionDomain.listExecutions(database.db, actor, {
				...reference,
				beforeId: first.nextCursor as string,
			}),
		),
	);
	expect(first.executions).toHaveLength(50);
	expect(second.executions).toHaveLength(2);
	expect(
		new Set(
			[...first.executions, ...second.executions].map(
				(item) => item.executionId,
			),
		).size,
	).toBe(52);
});
