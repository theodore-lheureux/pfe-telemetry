import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import type { ExecutionLoad } from "../../src/executions/overlaps";
import * as overlaps from "../../src/executions/overlaps.server";
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
	database = await createTestDatabase("overlaps");
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

const executionKey = "slurm:48213";
const window = {
	from: new Date("2026-11-03T10:00:00Z"),
	to: new Date("2026-11-03T11:00:00Z"),
};

async function scenario() {
	const [owner, admin, viewer, member, outsider] = await Promise.all(
		Array.from({ length: 5 }, actor),
	);
	const organization = data(
		await requests(owner.headers, () =>
			organizations.createOrganization(auth, owner.headers, {
				name: "Overlaps",
				slug: `overlaps-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await requests(owner.headers, (actor) =>
			projects.createProject(database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Shared nodes",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const add = (userId: string, role: "admin" | "member") =>
		auth.api.addMember({
			body: { organizationId: organization.id, userId, role },
		});
	await add(admin.id, "admin");
	await add(member.id, "member");
	const viewerMembership = await add(viewer.id, "member");
	data(
		await requests(owner.headers, (actor) =>
			projects.setProjectMember(database.db, actor, {
				...reference,
				memberId: viewerMembership.id,
				role: "viewer",
			}),
		),
	);
	const calls: string[] = [];
	const { nodeId } = await createTestNode(database.db, reference, {
		hostname: "gpu-07",
	});
	const readers: overlaps.OverlapReaders = {
		spans: async (projectId, key) => {
			calls.push(`spans:${projectId}:${key}`);
			return projectId === project.id && key === executionKey
				? [{ nodeId, ...window }]
				: [];
		},
		overlaps: async (projectId) => {
			calls.push(`overlaps:${projectId}`);
			return {
				more: false,
				executions: [
					{
						executionKey: "slurm:48214",
						name: "Neighbour",
						workloadVersion: null,
						nodeCount: 1,
						nodeIds: [nodeId],
						...window,
					},
				],
			};
		},
		load: async (projectId, key, spans): Promise<ExecutionLoad> => {
			calls.push(`load:${projectId}:${key}:${spans.length}`);
			return {
				...window,
				bucketSeconds: 60,
				nodeCount: spans.length,
				metrics: { cpu: null, memory: null },
			};
		},
	};
	return {
		owner,
		admin,
		viewer,
		member,
		outsider,
		reference,
		viewerMembership,
		readers,
		calls,
	};
}

type Scenario = Awaited<ReturnType<typeof scenario>>;
function read(
	f: Scenario,
	headers: Headers,
	input: Scenario["reference"] & { executionKey: string },
) {
	return Promise.all([
		requests(headers, (actor) =>
			overlaps.getExecutionOverlaps(
				database.db,
				actor,
				input,
				undefined,
				f.readers,
			),
		),
		requests(headers, (actor) =>
			overlaps.getExecutionLoad(
				database.db,
				actor,
				input,
				undefined,
				f.readers,
			),
		),
	]);
}

test("project viewers and organization operators read the same project-scoped overlaps", async () => {
	const f = await scenario();
	const input = { ...f.reference, executionKey };
	const results = [];
	for (const reader of [f.viewer, f.owner, f.admin]) {
		const [list, load] = await read(f, reader.headers, input);
		results.push({ list: data(list), load: data(load) });
	}
	expect(results[1]).toEqual(results[0]);
	expect(results[2]).toEqual(results[0]);
	const { list, load } = results[0];
	expect(list.executions).toMatchObject([
		{ executionKey: "slurm:48214", nodes: [{ hostname: "gpu-07" }] },
	]);
	expect(load).toMatchObject({ nodeCount: 1, metrics: { cpu: null } });
	expect(
		f.calls.every((call) => call.includes(f.reference.projectId)),
	).toBeTrue();
});

test("overlap reads authorize the project before any ClickHouse read", async () => {
	const f = await scenario();
	const input = { ...f.reference, executionKey };
	for (const [headers, code] of [
		[f.outsider.headers, "NOT_FOUND"],
		[f.member.headers, "NOT_FOUND"],
		[new Headers(), "UNAUTHENTICATED"],
	] as const)
		expect(
			(await read(f, headers, input)).map((result) => result.error?.code),
		).toEqual([code, code]);
	expect(f.calls).toEqual([]);
	data(
		await requests(f.owner.headers, (actor) =>
			projects.removeProjectMember(database.db, actor, {
				...f.reference,
				memberId: f.viewerMembership.id,
			}),
		),
	);
	expect(
		(await read(f, f.viewer.headers, input)).map((r) => r.error?.code),
	).toEqual(["NOT_FOUND", "NOT_FOUND"]);
	expect(f.calls).toEqual([]);
	expect(
		(await read(f, f.owner.headers, { ...input, executionKey: "missing" })).map(
			(result) => result.error?.code,
		),
	).toEqual(["NOT_FOUND", "NOT_FOUND"]);
	expect(f.calls.some((call) => call.startsWith("overlaps:"))).toBeFalse();
	expect(f.calls.some((call) => call.startsWith("load:"))).toBeFalse();
});

test("an execution key from another project or organization is not found", async () => {
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
		{ ...f.reference, projectId: other.reference.projectId },
		other.reference,
	])
		expect(
			(await read(f, f.viewer.headers, { ...reference, executionKey })).map(
				(result) => result.error?.code,
			),
		).toEqual(["NOT_FOUND", "NOT_FOUND"]);
	// The owner may read the sibling project, whose spans the reader scopes to it.
	expect(
		(
			await read(f, f.owner.headers, {
				...f.reference,
				projectId: sibling.id,
				executionKey,
			})
		).map((result) => result.error?.code),
	).toEqual(["NOT_FOUND", "NOT_FOUND"]);
	expect(f.calls).toEqual([
		`spans:${sibling.id}:${executionKey}`,
		`spans:${sibling.id}:${executionKey}`,
	]);
});
