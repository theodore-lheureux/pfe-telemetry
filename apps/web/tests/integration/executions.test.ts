import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import type {
	ExecutionFact,
	ExecutionMeasurementsInput,
} from "../../src/executions/contracts";
import * as executions from "../../src/executions/executions.server";
import type { readExecutionMeasurements } from "../../src/executions/measurements.server";
import type {
	readExecutionFacts,
	readExecutions,
} from "../../src/executions/participants.server";
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
		expect(selector).toEqual({ afterKey: "run:049" });
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

test("execution measurements authorize before reading facts and stay within the execution's nodes", async () => {
	const f = await scenario();
	const ref = { ...f.reference, executionKey: f.entry.executionKey };
	const { nodeId } = await createTestNode(database.db, f.reference, {
		hostname: "compute-a",
		machineId: "compute-a",
	});
	// Another enrolled node of the project is not named on this execution's page.
	await createTestNode(database.db, f.reference, {
		hostname: "idle",
		machineId: "idle",
	});
	const facts: ExecutionFact[] = [
		{
			nodeId,
			participantId: "participant-a",
			factId: "participant-a",
			kind: 1,
			processResourceId: null,
			namespaceId: null,
			pid: null,
			startTimeTicks: null,
			ownerUid: null,
			environmentVariable: "SLURM_JOB_ID",
			firstSeen: f.entry.firstSeen,
			lastSeen: f.entry.lastSeen,
			ended: null,
		},
	];
	let factReads = 0;
	const measured: (string | undefined)[] = [];
	const readFacts: typeof readExecutionFacts = async (projectId, key) => {
		factReads++;
		expect(projectId).toBe(f.reference.projectId);
		return key === f.entry.executionKey ? facts : [];
	};
	const measure: typeof readExecutionMeasurements = async (
		projectId,
		key,
		read,
		node,
	) => {
		expect(projectId).toBe(f.reference.projectId);
		expect(key).toBe(f.entry.executionKey);
		expect(read).toBe(facts);
		measured.push(node);
		return null;
	};
	const run = (
		headers: Headers,
		input: ExecutionMeasurementsInput = ref,
		project = f.reference,
	) =>
		requests(headers, (actor) =>
			executions.getExecutionMeasurements(
				database.db,
				actor,
				{ ...input, ...project },
				undefined,
				readFacts,
				measure,
			),
		);
	for (const reader of [f.owner, f.viewer])
		expect(data(await run(reader.headers, { ...ref, node: nodeId }))).toBe(
			null,
		);
	expect(measured).toEqual([nodeId, nodeId]);
	const sibling = data(
		await requests(f.owner.headers, (actor) =>
			projects.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: f.reference.organizationId,
				name: "Sibling",
			}),
		),
	);
	const reads = factReads;
	for (const [headers, project, code] of [
		[f.outsider.headers, f.reference, "NOT_FOUND"],
		[new Headers(), f.reference, "UNAUTHENTICATED"],
		[f.viewer.headers, { ...f.reference, projectId: sibling.id }, "NOT_FOUND"],
	] as const)
		expect((await run(headers, ref, project)).error?.code).toBe(code);
	expect(factReads).toBe(reads);
	// A node outside the execution and a key without facts never reach the measurement read.
	expect(
		(await run(f.owner.headers, { ...ref, node: "node-b" })).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(await run(f.owner.headers, { ...ref, executionKey: "missing" })).error
			?.code,
	).toBe("NOT_FOUND");
	expect(measured).toHaveLength(2);
	expect(
		data(
			await requests(f.viewer.headers, (actor) =>
				executions.getExecution(
					database.db,
					actor,
					ref,
					undefined,
					f.read,
					readFacts,
				),
			),
		).nodeNames,
	).toEqual({ [nodeId]: "compute-a" });
});
