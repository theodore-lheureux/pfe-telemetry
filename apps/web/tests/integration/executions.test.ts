import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as credentialDomain from "../../src/credentials/credentials.server";
import { execution, member } from "../../src/db/schema";
import * as executionDomain from "../../src/executions/executions.server";
import { queryExecutionTelemetry } from "../../src/executions/executions.server";
import { parseCreateExecution } from "../../src/executions/validation";
import type { OperationResult } from "../../src/organizations/contracts";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

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
	await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
	await auth.emailDelivery.drain();
	const otp = codes.get(email);
	if (!otp) throw new Error("Expected captured sign-in code");
	const response = await auth.api.signInEmailOTP({
		body: { email, otp },
		headers: { origin },
		asResponse: true,
	});
	const headers = new Headers({
		origin,
		cookie: response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; "),
	});
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected session");
	return { id: session.user.id, headers };
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

test("independent canonical access, immutable source selection, tenant-qualified cursors and project-wide reads", async () => {
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
				slug: "private",
			}),
		),
	);
	const other = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Other",
				slug: "other",
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
	const credentials = actorService(auth);
	const credential = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				...reference,
				name: "Collector",
				sourceId: "source",
				rootId: "node1",
				rootKind: 1,
				adapter: "linux",
				allowedLocalKinds: [4],
			}),
		),
	);
	const otherCredential = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				organizationId: organization.id,
				projectId: other.id,
				name: "Other",
				sourceId: "foreign",
				rootId: "node2",
				rootKind: 1,
				adapter: "linux",
				allowedLocalKinds: [4],
			}),
		),
	);
	const input = parseCreateExecution({
		requestId: crypto.randomUUID(),
		...reference,
		credentialId: credential.credential.id,
		name: "Recorded",
		hostId: "node1",
		startedAt: "2026-11-03T10:00:00Z",
		endedAt: "2026-11-03T11:00:00Z",
	});
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
					credentialId: otherCredential.credential.id,
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
	).toBe("source");
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
		sourceId: "source",
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
	data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, {
				...reference,
				credentialId: credential.credential.id,
			}),
		),
	);
	expect(
		data(
			await requests(viewer.headers, (actor) =>
				executionDomain.getExecution(database.db, actor, ref),
			),
		).sourceId,
	).toBe("source");
	const inserted = Array.from({ length: 51 }, () => ({
		id: uuidv7(),
		organizationId: organization.id,
		projectId: project.id,
		name: "Page",
		sourceId: "source",
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
