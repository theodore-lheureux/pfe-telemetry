import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	createReceipt,
	execution,
	member,
	project,
	projectMember,
	user,
} from "../../src/db/schema";
import type { CreateExecutionInput } from "../../src/executions/contracts";
import * as executionDomain from "../../src/executions/executions.server";
import { createInputHash, createOnce } from "../../src/lib/create-once.server";
import type { OperationResult } from "../../src/lib/operation-result";
import {
	requireOrganization,
	requireProject,
} from "../../src/organizations/access.server";
import type { CreateProjectInput } from "../../src/organizations/contracts";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { trustedActor } from "../auth-actors";
import { createTestNode } from "../collector-node";
import { createTestDatabase } from "../database";
import { gate } from "../gate";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let organizations: ReturnType<typeof actorService>;
let executions: ReturnType<typeof actorService>;
const origin = "http://localhost:3063";
const codes = new Map<string, string>();
type Transaction = Parameters<Parameters<typeof database.db.transaction>[0]>[0];
type Kind = "project" | "execution";

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}
async function actor() {
	return trustedActor(
		auth,
		`${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
}
beforeAll(async () => {
	database = await createTestDatabase("create_once", 8);
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `create-test-${randomUUID()}`,
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
	organizations = actorService(auth);
	executions = actorService(auth);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

async function scenario(kind: Kind) {
	const owner = await actor();
	const creator = await actor();
	const organization = data(
		await organizations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Creates",
				slug: `creates-${randomUUID()}`,
			}),
		),
	);
	const membership = await auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: creator.id,
			role: kind === "project" ? "admin" : "member",
		},
	});
	const base = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Base",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: base.id };
	if (kind === "execution")
		data(
			await organizations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: membership.id,
					role: "member",
				}),
			),
		);
	const { nodeId } = await createTestNode(database.db, reference);
	const requestId = randomUUID();
	const projectInput: CreateProjectInput = {
		requestId,
		organizationId: organization.id,
		name: "Created",
	};
	const executionInput: CreateExecutionInput = {
		...reference,
		requestId,
		name: "Created",
		nodeId,
		hostId: null,
		startedAt: "2026-11-03T10:00:00.000Z",
		endedAt: "2026-11-03T10:05:00.000Z",
	};
	const scope =
		kind === "project"
			? ({
					operation: "create-project",
					organizationId: organization.id,
					projectId: null,
				} as const)
			: ({ operation: "create-execution", ...reference } as const);
	const submission = kind === "project" ? projectInput : executionInput;
	return {
		owner,
		creator,
		membership,
		reference,
		requestId,
		scope,
		submission,
		projectInput,
		executionInput,
		attempt: (
			changes: Partial<CreateProjectInput & CreateExecutionInput> = {},
			headers = creator.headers,
		) =>
			kind === "project"
				? organizations(headers, (actor) =>
						projectDomain.createProject(database.db, actor, {
							...projectInput,
							...changes,
						}),
					)
				: executions(headers, (actor) =>
						executionDomain.createExecution(database.db, actor, {
							...executionInput,
							...changes,
						}),
					),
		async insertResource(tx: Transaction, id: string) {
			if (kind === "project")
				await tx.insert(project).values({
					id,
					organizationId: organization.id,
					name: projectInput.name,
					createdBy: creator.id,
				});
			else
				await tx.insert(execution).values({
					id,
					...reference,
					sourceId: nodeId,
					hostId: null,
					name: executionInput.name,
					startedAt: new Date(executionInput.startedAt),
					endedAt: new Date(executionInput.endedAt),
					createdBy: creator.id,
				});
		},
		authorize: async (tx: Transaction) => {
			if (kind === "project")
				return requireOrganization(tx, creator, organization.id);
			return requireProject(tx, creator, reference);
		},
		async revoke() {
			if (kind === "project")
				await database.db
					.update(member)
					.set({ role: "member" })
					.where(eq(member.id, membership.id));
			else
				await database.db
					.delete(projectMember)
					.where(
						and(
							eq(projectMember.projectId, base.id),
							eq(projectMember.memberId, membership.id),
						),
					);
		},
		async receipts() {
			return database.db
				.select()
				.from(createReceipt)
				.where(
					and(
						eq(createReceipt.actorId, creator.id),
						eq(createReceipt.requestId, requestId),
					),
				);
		},
		async resources() {
			return kind === "project"
				? database.db
						.select({ id: project.id })
						.from(project)
						.where(
							and(
								eq(project.organizationId, organization.id),
								ne(project.id, base.id),
							),
						)
				: database.db
						.select({ id: execution.id })
						.from(execution)
						.where(
							and(
								eq(execution.projectId, base.id),
								eq(execution.createdBy, creator.id),
							),
						);
		},
	};
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
type Reply = Awaited<ReturnType<Scenario["attempt"]>>;
function created(reply: Reply) {
	if (reply.error) throw new Error(reply.error.message);
	return reply.data;
}
function id(reply: Reply) {
	const entry = created(reply);
	return "executionId" in entry ? entry.executionId : entry.id;
}
async function receiptWait(blockerPid: number) {
	const deadline = performance.now() + 5_000;
	do {
		const blocked = await database.pool.query(
			`SELECT pid FROM pg_stat_activity
			WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
			AND wait_event_type = 'Lock' AND query LIKE '%create_receipt%'`,
			[blockerPid],
		);
		if (blocked.rowCount) return;
	} while (performance.now() < deadline);
	throw new Error("Expected a receipt arbitration lock wait");
}

for (const kind of ["project", "execution"] as const) {
	test(`${kind} creates deduplicate concurrent calls and replay current authorized summaries`, async () => {
		const fixture = await scenario(kind);
		const replies = await Promise.all(
			Array.from({ length: 6 }, () => fixture.attempt()),
		);
		const savedId = id(replies[0]);
		expect(replies.map(id)).toEqual(Array(6).fill(savedId));
		expect(await fixture.resources()).toEqual([{ id: savedId }]);
		expect(await fixture.receipts()).toHaveLength(1);
		if (kind === "project")
			data(
				await organizations(fixture.creator.headers, (actor) =>
					projectDomain.updateProject(database.db, actor, {
						organizationId: fixture.reference.organizationId,
						projectId: savedId,
						name: "Renamed",
					}),
				),
			);
		else
			data(
				await executions(fixture.creator.headers, (actor) =>
					executionDomain.updateExecution(database.db, actor, {
						...fixture.reference,
						executionId: savedId,
						name: "Renamed",
					}),
				),
			);
		// The first committed response may be lost; its retry must read, not create.
		const replay = created(await fixture.attempt({ name: " Created " }));
		expect(replay.name).toBe("Renamed");
		if ("startedAt" in replay) {
			expect(replay.startedAt).toBeInstanceOf(Date);
			expect(replay.createdAt).toBeInstanceOf(Date);
			expect(savedId[14]).toBe("7");
		}
		expect(await fixture.resources()).toHaveLength(1);
	});

	test(`${kind} receipts reject changed input and scope without exposing another actor's result`, async () => {
		const fixture = await scenario(kind);
		const savedId = id(await fixture.attempt());
		for (const change of kind === "project"
			? [{ name: "Other" }]
			: [
					{ name: "Other" },
					{ hostId: "Node-A" },
					{ startedAt: "2026-11-03T10:01:00Z" },
					{ endedAt: "2026-11-03T10:06:00Z" },
					{ nodeId: randomUUID() },
				]) {
			const rejected = await fixture.attempt(change);
			expect(rejected).toMatchObject({
				data: null,
				error: { code: "CONFLICT", reason: "REQUEST_ID_REUSED" },
			});
			expect(JSON.stringify(rejected)).not.toContain(savedId);
		}
		const outsider = await actor();
		expect(await fixture.attempt({}, outsider.headers)).toMatchObject({
			data: null,
			error: { code: "NOT_FOUND" },
		});
		expect(await fixture.attempt({}, new Headers())).toMatchObject({
			data: null,
			error: { code: "UNAUTHENTICATED" },
		});
		const otherOrg = data(
			await organizations(fixture.creator.headers, () =>
				organizationDomain.createOrganization(auth, fixture.creator.headers, {
					name: "Other",
					slug: `other-${randomUUID()}`,
				}),
			),
		);
		const reused = await organizations(fixture.creator.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				...fixture.projectInput,
				organizationId: otherOrg.id,
			}),
		);
		expect(reused).toMatchObject({
			data: null,
			error: { reason: "REQUEST_ID_REUSED" },
		});
		if (kind === "execution")
			await auth.api.updateMemberRole({
				headers: fixture.owner.headers,
				body: {
					organizationId: fixture.reference.organizationId,
					memberId: fixture.membership.id,
					role: "admin",
				},
			});
		const changedKind =
			kind === "project"
				? await executions(fixture.creator.headers, (actor) =>
						executionDomain.createExecution(
							database.db,
							actor,
							fixture.executionInput,
						),
					)
				: await organizations(fixture.creator.headers, (actor) =>
						projectDomain.createProject(
							database.db,
							actor,
							fixture.projectInput,
						),
					);
		expect(changedKind).toMatchObject({
			data: null,
			error: { code: "CONFLICT", reason: "REQUEST_ID_REUSED" },
		});
		const otherActor = await fixture.attempt(
			{ name: "Other actor" },
			fixture.owner.headers,
		);
		expect(id(otherActor)).not.toBe(savedId);
		if (kind === "execution")
			await auth.api.updateMemberRole({
				headers: fixture.owner.headers,
				body: {
					organizationId: fixture.reference.organizationId,
					memberId: fixture.membership.id,
					role: "member",
				},
			});
		await fixture.revoke();
		expect(await fixture.attempt()).toMatchObject({
			data: null,
			error: { code: kind === "project" ? "FORBIDDEN" : "NOT_FOUND" },
		});
	});

	test(`${kind} resource failure rolls back its receipt and permits a later attempt`, async () => {
		const fixture = await scenario(kind);
		const candidate = kind === "project" ? randomUUID() : uuidv7();
		const failure = new Error("Fixture read failure after business insert");
		await expect(
			createOnce(database.db, {
				actorId: fixture.creator.id,
				scope: fixture.scope,
				submission: fixture.submission,
				resourceId: candidate,
				authorize: fixture.authorize,
				create: fixture.insertResource,
				read: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(await fixture.receipts()).toHaveLength(0);
		expect(await fixture.resources()).toHaveLength(0);
		expect(id(await fixture.attempt())).not.toBe(candidate);
		expect(await fixture.receipts()).toHaveLength(1);
	});

	for (const original of ["commit", "rollback"] as const) {
		test(`${kind} denies revoked authority after a receipt wait becomes ${original === "commit" ? "a replay" : "the winning insert"}`, async () => {
			const fixture = await scenario(kind);
			const reserved = kind === "project" ? randomUUID() : uuidv7();
			const ready = gate();
			const release = gate();
			let blockerPid = 0;
			const rollback = new Error("Expected original rollback");
			const blocker = database.db
				.transaction(async (tx) => {
					const result = await tx.execute<{ pid: number }>(
						sql`SELECT pg_backend_pid() AS pid`,
					);
					blockerPid = result.rows[0].pid;
					await tx.insert(createReceipt).values({
						actorId: fixture.creator.id,
						requestId: fixture.requestId,
						...fixture.scope,
						inputHash: createInputHash(
							fixture.scope,
							fixture.creator.id,
							fixture.submission,
						),
						resourceId: reserved,
					});
					ready.release();
					await release.promise;
					if (original === "rollback") throw rollback;
					await fixture.insertResource(tx, reserved);
				})
				.then(
					() => null,
					(error: unknown) => error,
				);
			let waiting: ReturnType<Scenario["attempt"]> | undefined;
			try {
				await Promise.race([
					ready.promise,
					blocker.then(() => {
						throw new Error("Original reservation failed before its gate");
					}),
				]);
				waiting = fixture.attempt();
				await receiptWait(blockerPid);
				await fixture.revoke();
				release.release();
				expect(await blocker).toBe(original === "rollback" ? rollback : null);
				expect(await waiting).toMatchObject({
					data: null,
					error: { code: kind === "project" ? "FORBIDDEN" : "NOT_FOUND" },
				});
				expect(await fixture.receipts()).toHaveLength(
					original === "rollback" ? 0 : 1,
				);
				expect(await fixture.resources()).toHaveLength(
					original === "rollback" ? 0 : 1,
				);
			} finally {
				release.release();
				await blocker;
				await waiting;
			}
		});
	}

	test(`${kind} replay cannot recreate a deleted result or reuse a revoked session`, async () => {
		const fixture = await scenario(kind);
		const savedId = id(await fixture.attempt());
		if (kind === "project")
			await database.db.delete(project).where(eq(project.id, savedId));
		else await database.db.delete(execution).where(eq(execution.id, savedId));
		expect(await fixture.attempt()).toMatchObject({
			data: null,
			error: { code: "NOT_FOUND" },
		});
		expect(await fixture.receipts()).toHaveLength(1);
		expect(await fixture.resources()).toHaveLength(0);
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, fixture.creator.id));
		expect(await fixture.attempt()).toMatchObject({
			data: null,
			error: { code: "FORBIDDEN", reason: "VERIFIED_EMAIL_REQUIRED" },
		});
		await auth.api.signOut({ headers: fixture.creator.headers });
		expect(await fixture.attempt()).toMatchObject({
			data: null,
			error: { code: "UNAUTHENTICATED" },
		});
	});
}

test("receipt constraints reject unsupported operations, hashes and cross-tenant project scopes", async () => {
	const fixture = await scenario("project");
	const other = data(
		await organizations(fixture.owner.headers, () =>
			organizationDomain.createOrganization(auth, fixture.owner.headers, {
				name: "Other",
				slug: `constraint-${randomUUID()}`,
			}),
		),
	);
	const receipt = {
		actorId: fixture.creator.id,
		requestId: randomUUID(),
		...fixture.scope,
		inputHash: createInputHash(
			fixture.scope,
			fixture.creator.id,
			fixture.submission,
		),
		resourceId: randomUUID(),
	};
	for (const change of [
		{ operation: "constructor" },
		{ inputHash: "invalid" },
		{ projectId: fixture.reference.projectId },
		{ operation: "create-execution", projectId: null },
		{
			operation: "create-execution",
			projectId: fixture.reference.projectId,
			organizationId: other.id,
		},
	])
		await expect(
			database.db
				.insert(createReceipt)
				.values({ ...receipt, ...change })
				.execute(),
		).rejects.toThrow();
	expect(
		await database.db
			.select()
			.from(createReceipt)
			.where(eq(createReceipt.requestId, receipt.requestId)),
	).toHaveLength(0);
});
