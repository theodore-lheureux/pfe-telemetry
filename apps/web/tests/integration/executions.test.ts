import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as executions from "../../src/executions/executions.server";
import type {
	readExecutionFacts,
	readExecutionFilterOptions,
	readExecutions,
} from "../../src/executions/participants.server";
import { parseExecutionList } from "../../src/executions/validation";
import type { OperationResult } from "../../src/lib/operation-result";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
import { createTestNode } from "../collector-node";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let requests: ReturnType<typeof actorService>;
const origin = "http://localhost:3001";
const codes = new Map<string, string>();
function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}
function actor() {
	return trustedActor(
		auth,
		`${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
}
beforeAll(async () => {
	database = await createTestDatabase("executions");
	auth = createAuth(
		{ origin, rpID: "localhost", secret: randomUUID(), allowSignUp: true },
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	requests = actorService(auth);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});
async function scenario() {
	const owner = await actor(),
		viewer = await actor(),
		outsider = await actor();
	const organization = data(
		await requests(owner.headers, () =>
			organizations.createOrganization(auth, owner.headers, {
				name: "Executions",
				slug: `executions-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await requests(owner.headers, (actor) =>
			projects.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Private",
			}),
		),
	);
	const membership = await auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: viewer.id,
			role: "member",
		},
	});
	const reference = { organizationId: organization.id, projectId: project.id };
	data(
		await requests(owner.headers, (actor) =>
			projects.setProjectMember(database.db, actor, {
				...reference,
				memberId: membership.id,
				role: "viewer",
			}),
		),
	);
	const entry = {
		executionKey: "slurm:48213",
		name: "Distributed job",
		workloadVersion: "build-a",
		parameters: { size: "32" },
		nodeCount: 2,
		participantCount: 2,
		environmentVariables: ["SLURM_JOB_ID"],
		firstSeen: new Date("2026-11-03T10:00:00Z"),
		lastSeen: new Date("2026-11-03T11:00:00Z"),
		running: false,
		nodeIds: [] as string[],
		ownerUids: [1000],
	};
	let reads = 0;
	const read: typeof readExecutions = async (projectId, selector = {}) => {
		reads++;
		expect(projectId).toBe(project.id);
		if (selector.executionKey && selector.executionKey !== entry.executionKey)
			return [];
		return [entry];
	};
	let factReads = 0;
	const readFacts: typeof readExecutionFacts = async (projectId, key) => {
		factReads++;
		expect(projectId).toBe(project.id);
		expect(key).toBe(entry.executionKey);
		return [];
	};
	return {
		owner,
		viewer,
		outsider,
		reference,
		membership,
		entry,
		read,
		readFacts,
		reads: () => reads,
		factReads: () => factReads,
	};
}
test("execution reads require canonical project access before any ClickHouse read", async () => {
	const f = await scenario();
	const ref = { ...f.reference, executionKey: f.entry.executionKey };
	for (const reader of [f.owner, f.viewer]) {
		expect(
			data(
				await requests(reader.headers, (actor) =>
					executions.getExecution(
						database.db,
						actor,
						ref,
						undefined,
						f.read,
						f.readFacts,
					),
				),
			),
		).toMatchObject(f.entry);
		expect(
			data(
				await requests(reader.headers, (actor) =>
					executions.listExecutions(
						database.db,
						actor,
						f.reference,
						undefined,
						f.read,
					),
				),
			).executions,
		).toHaveLength(1);
	}
	const before = f.reads();
	const factsBefore = f.factReads();
	for (const headers of [f.outsider.headers, new Headers()]) {
		const expected =
			headers === f.outsider.headers ? "NOT_FOUND" : "UNAUTHENTICATED";
		expect(
			(
				await requests(headers, (actor) =>
					executions.getExecution(
						database.db,
						actor,
						ref,
						undefined,
						f.read,
						f.readFacts,
					),
				)
			).error?.code,
		).toBe(expected);
		expect(
			(
				await requests(headers, (actor) =>
					executions.listExecutions(
						database.db,
						actor,
						f.reference,
						undefined,
						f.read,
					),
				)
			).error?.code,
		).toBe(expected);
	}
	expect(f.reads()).toBe(before);
	expect(f.factReads()).toBe(factsBefore);
	expect(
		(
			await requests(f.owner.headers, (actor) =>
				executions.getExecution(
					database.db,
					actor,
					{ ...ref, executionKey: "missing" },
					undefined,
					f.read,
					f.readFacts,
				),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	data(
		await requests(f.owner.headers, (actor) =>
			projects.removeProjectMember(database.db, actor, {
				...f.reference,
				memberId: f.membership.id,
			}),
		),
	);
	const after = f.reads();
	expect(
		(
			await requests(f.viewer.headers, (actor) =>
				executions.getExecution(
					database.db,
					actor,
					ref,
					undefined,
					f.read,
					f.readFacts,
				),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(f.reads()).toBe(after);
	expect(f.factReads()).toBe(factsBefore);
	expect(
		(
			await database.pool.query(
				"SELECT to_regclass('app.execution') AS execution",
			)
		).rows[0].execution,
	).toBeNull();
});

test("execution pagination returns key cursors and propagates analytics failures", async () => {
	const f = await scenario();
	const entries = Array.from({ length: 51 }, (_, i) => ({
		...f.entry,
		executionKey: `run:${String(i).padStart(3, "0")}`,
	}));
	const first = data(
		await requests(f.viewer.headers, (actor) =>
			executions.listExecutions(
				database.db,
				actor,
				f.reference,
				undefined,
				async () => entries,
			),
		),
	);
	expect(first.executions).toHaveLength(50);
	expect(first.nextCursor).toBe("run:049");
	const read: typeof readExecutions = async (projectId, selector) => {
		expect(projectId).toBe(f.reference.projectId);
		expect(selector).toEqual({ afterKey: "run:049", filters: {} });
		return [entries[50]];
	};
	const second = data(
		await requests(f.viewer.headers, (actor) =>
			executions.listExecutions(
				database.db,
				actor,
				{ ...f.reference, afterKey: first.nextCursor as string },
				undefined,
				read,
			),
		),
	);
	expect(second.executions.map((entry) => entry.executionKey)).toEqual([
		"run:050",
	]);
	expect(second.nextCursor).toBeNull();
	const failure = new Error("Analytics unavailable");
	await expect(
		executions.listExecutions(
			database.db,
			f.viewer,
			f.reference,
			undefined,
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
});

test("identical execution keys do not grant reads in another project or organization", async () => {
	const f = await scenario();
	const other = await scenario();
	const sibling = data(
		await requests(f.owner.headers, (actor) =>
			projects.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: f.reference.organizationId,
				name: "Sibling",
			}),
		),
	);
	for (const reference of [
		{ ...f.reference, projectId: sibling.id },
		other.reference,
		{ ...f.reference, projectId: other.reference.projectId },
	]) {
		for (const operation of [
			() =>
				requests(f.viewer.headers, (actor) =>
					executions.listExecutions(
						database.db,
						actor,
						reference,
						undefined,
						f.read,
					),
				),
			() =>
				requests(f.viewer.headers, (actor) =>
					executions.getExecution(
						database.db,
						actor,
						{ ...reference, executionKey: f.entry.executionKey },
						undefined,
						f.read,
					),
				),
		]) {
			expect((await operation()).error?.code).toBe("NOT_FOUND");
		}
	}
	expect(f.reads()).toBe(0);
});

test("execution filters reach the reader and node names stay within the project", async () => {
	const f = await scenario();
	const other = await scenario();
	const local = await createTestNode(database.db, f.reference, {
		hostname: "compute-a",
	});
	const foreign = await createTestNode(database.db, other.reference, {
		hostname: "foreign-host",
	});
	const input = parseExecutionList({
		...f.reference,
		q: "job",
		application: ["Distributed job"],
		state: "running",
		machine: [local.nodeId.toUpperCase()],
		owner: [1000, 0],
		from: new Date("2026-11-03T00:00:00Z"),
		to: new Date("2026-11-04T00:00:00Z"),
	});
	const { organizationId: _, projectId: __, ...filters } = input;
	let seen: Parameters<typeof readExecutions>[1];
	const read: typeof readExecutions = async (projectId, selector) => {
		expect(projectId).toBe(f.reference.projectId);
		seen = selector;
		return [
			{
				...f.entry,
				nodeIds: [local.nodeId, foreign.nodeId, "fixture-node"],
			},
		];
	};
	const page = data(
		await requests(f.viewer.headers, (actor) =>
			executions.listExecutions(database.db, actor, input, undefined, read),
		),
	);
	expect(seen).toEqual({ afterKey: undefined, filters });
	expect(filters.machine).toEqual([local.nodeId]);
	expect(page.nodes).toEqual([
		{ id: local.nodeId, hostname: "compute-a" },
		{ id: foreign.nodeId, hostname: null },
		{ id: "fixture-node", hostname: null },
	]);
	expect(JSON.stringify(page)).not.toContain("foreign-host");
});

test("filter options require project access, name only the project's nodes and offer only node UUIDs", async () => {
	const f = await scenario();
	const other = await scenario();
	const local = await createTestNode(database.db, f.reference, {
		hostname: "compute-a",
	});
	const foreign = await createTestNode(database.db, other.reference, {
		hostname: "foreign-host",
	});
	let reads = 0;
	const read: typeof readExecutionFilterOptions = async (projectId) => {
		reads++;
		expect(projectId).toBe(f.reference.projectId);
		return {
			applications: ["Distributed job"],
			machines: [local.nodeId, foreign.nodeId, "fixture-node"],
			owners: [0, 1000],
		};
	};
	const options = (headers: Headers, reference = f.reference) =>
		requests(headers, (actor) =>
			executions.listExecutionFilterOptions(
				database.db,
				actor,
				reference,
				undefined,
				read,
			),
		);
	for (const reader of [f.owner, f.viewer])
		expect(data(await options(reader.headers))).toEqual({
			applications: ["Distributed job"],
			machines: [
				{ id: local.nodeId, hostname: "compute-a" },
				{ id: foreign.nodeId, hostname: null },
			],
			owners: [0, 1000],
		});
	expect(reads).toBe(2);
	for (const [headers, reference, code] of [
		[f.outsider.headers, f.reference, "NOT_FOUND"],
		[other.viewer.headers, f.reference, "NOT_FOUND"],
		[f.viewer.headers, other.reference, "NOT_FOUND"],
		[new Headers(), f.reference, "UNAUTHENTICATED"],
	] as const)
		expect((await options(headers, reference)).error?.code).toBe(code);
	expect(reads).toBe(2);
});
