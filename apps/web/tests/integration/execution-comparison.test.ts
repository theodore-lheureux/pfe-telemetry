import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runAnalyticsQuery } from "../../src/analytics/analytics.server";
import type {
	AnalyticsQuery,
	QueryResult,
} from "../../src/analytics/contracts";
import { parseRunQueryInput } from "../../src/analytics/validation";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import type { OperationResult } from "../../src/lib/operation-result";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { trustedActor } from "../auth-actors";
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
	database = await createTestDatabase("exec_compare");
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

/** An owner with two projects in one organization, a viewer of the first and an outsider. */
async function scenario() {
	const owner = await actor(),
		viewer = await actor(),
		outsider = await actor();
	const organization = data(
		await requests(owner.headers, () =>
			organizations.createOrganization(auth, owner.headers, {
				name: "Comparison",
				slug: `comparison-${randomUUID()}`,
			}),
		),
	);
	const create = async (name: string) =>
		data(
			await requests(owner.headers, (actor) =>
				projects.createProject(database.db, actor, {
					requestId: randomUUID(),
					organizationId: organization.id,
					name,
				}),
			),
		);
	const [project, sibling] = [await create("Runs"), await create("Sibling")];
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
	return {
		owner,
		viewer,
		outsider,
		reference,
		sibling: { organizationId: organization.id, projectId: sibling.id },
	};
}

const query = {
	shape: "timeseries",
	range: { executions: ["run:a", "run:b"] },
	interval: "10s",
	measures: [
		{
			name: "cpu",
			metric: "process.cpu.time",
			calculation: "rate",
			combine: "sum",
		},
	],
};

test("aligned execution queries authorize the project before any ClickHouse read", async () => {
	const f = await scenario();
	const runs: { projectId: string; query: AnalyticsQuery }[] = [];
	const run = async (projectId: string, input: AnalyticsQuery) => {
		runs.push({ projectId, query: input });
		return { series: [] } as unknown as QueryResult;
	};
	const input = (reference: typeof f.reference) =>
		parseRunQueryInput({ ...reference, query });
	data(
		await requests(f.viewer.headers, (actor) =>
			runAnalyticsQuery(database.db, actor, input(f.reference), undefined, run),
		),
	);
	expect(runs).toEqual([
		{
			projectId: f.reference.projectId,
			query: expect.objectContaining({
				range: { executions: ["run:a", "run:b"] },
			}),
		},
	]);
	for (const [headers, reference, code] of [
		[f.outsider.headers, f.reference, "NOT_FOUND"],
		[new Headers(), f.reference, "UNAUTHENTICATED"],
		// Project viewers have no access to the organization's other projects.
		[f.viewer.headers, f.sibling, "NOT_FOUND"],
	] as const)
		expect(
			(
				await requests(headers, (actor) =>
					runAnalyticsQuery(
						database.db,
						actor,
						input(reference),
						undefined,
						run,
					),
				)
			).error?.code,
		).toBe(code);
	expect(runs).toHaveLength(1);
});
