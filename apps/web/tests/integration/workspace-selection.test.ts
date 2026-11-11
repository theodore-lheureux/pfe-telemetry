import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuth } from "../../src/auth/create-auth.server";
import { projectMember } from "../../src/db/schema";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { readWorkspacePreference } from "../../src/organizations/workspace-preference";
import { resolveWorkspace } from "../../src/organizations/workspace-selection.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes = new Map<string, string>();
const origin = "http://localhost:3958";
beforeAll(async () => {
	database = await createTestDatabase("selection");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `selection-test-${randomUUID()}`,
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
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

test("remembered scopes select only currently authorized projects and fall back after revocation", async () => {
	const owner = await trustedActor(
		auth,
		"owner@example.invalid",
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	const collaborator = await trustedActor(
		auth,
		"member@example.invalid",
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	const actor = { id: owner.id, emailVerified: true };
	const memberActor = { id: collaborator.id, emailVerified: true };
	const first = await organizations.createOrganization(auth, owner.headers, {
		name: "First",
		slug: "first",
	});
	const second = await organizations.createOrganization(auth, owner.headers, {
		name: "Second",
		slug: "second",
	});
	const a = await projects.createProject(database.db, actor, {
		organizationId: first.id,
		name: "A",
		requestId: randomUUID(),
	});
	const hidden = await projects.createProject(database.db, actor, {
		organizationId: first.id,
		name: "Private",
		requestId: randomUUID(),
	});
	const b = await projects.createProject(database.db, actor, {
		organizationId: second.id,
		name: "B",
		requestId: randomUUID(),
	});
	for (const [org, project] of [
		[first, a],
		[second, b],
	] as const) {
		const member = await auth.api.addMember({
			body: { organizationId: org.id, userId: collaborator.id, role: "member" },
		});
		await projects.setProjectMember(database.db, actor, {
			organizationId: org.id,
			projectId: project.id,
			memberId: member.id,
			role: "viewer",
		});
	}
	const preference = {
		organizationId: first.id,
		projects: { [first.id]: hidden.id, [second.id]: b.id },
	};
	expect(
		(await resolveWorkspace(database.db, actor, {}, preference)).project?.id,
	).toBe(hidden.id);
	const selected = await resolveWorkspace(
		database.db,
		memberActor,
		{},
		preference,
	);
	expect(selected.project?.id).toBe(a.id);
	expect(selected.projects.some((project) => project.id === hidden.id)).toBe(
		false,
	);
	await database.db
		.delete(projectMember)
		.where(eq(projectMember.projectId, a.id));
	expect(
		(await resolveWorkspace(database.db, memberActor, {}, preference)).project
			?.id,
	).toBe(b.id);
	expect(
		(
			await resolveWorkspace(
				database.db,
				memberActor,
				{ organizationId: first.id },
				preference,
			)
		).project,
	).toBeUndefined();
	await expect(
		resolveWorkspace(
			database.db,
			memberActor,
			{ organizationId: first.id, projectId: hidden.id },
			preference,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		resolveWorkspace(
			database.db,
			memberActor,
			{ organizationId: "foreign-org" },
			preference,
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("workspace cookies are bounded hints, not trusted authorization", () => {
	for (const input of ["not-json", "null", "[]", '{"projects":[]}'])
		expect(readWorkspacePreference(input)).toEqual({ projects: {} });
	const preference = readWorkspacePreference(
		JSON.stringify({
			organizationId: "last",
			projects: Object.fromEntries(
				Array.from({ length: 20 }, (_, i) => [`org-${i}`, `project-${i}`]),
			),
		}),
	);
	expect(Object.keys(preference.projects)).toHaveLength(16);
	expect(preference.organizationId).toBe("last");
});
