import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OrganizationInvitationEmailProps } from "@recount/transactional";
import { and, eq } from "drizzle-orm";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import { member, projectMember, user } from "../../src/db/schema";
import type { OperationResult } from "../../src/lib/operation-result";
import type { OrganizationRole } from "../../src/organizations/contracts";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

const origin = "http://localhost:3062";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let operations: ReturnType<typeof actorService>;
const codes = new Map<string, string>();
const invitationEmails: OrganizationInvitationEmailProps[] = [];
let sequence = 0;

beforeAll(async () => {
	database = await createTestDatabase("members", 6);
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `member-test-only-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async (props) => {
				invitationEmails.push(props);
			},
		},
	);
	operations = actorService(auth);
});

afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	const id = ++sequence;
	const email = `member-${id}@example.invalid`;
	const account = await trustedActor(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	return { userId: account.id, email, headers: account.headers };
}

async function organization(owner: Awaited<ReturnType<typeof actor>>) {
	return data(
		await operations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Members test",
				slug: `members-${randomUUID()}`,
			}),
		),
	);
}

async function add(
	organizationId: string,
	person: Awaited<ReturnType<typeof actor>>,
	role: OrganizationRole = "member",
) {
	return auth.api.addMember({
		body: { organizationId, userId: person.userId, role },
	});
}

test("native invitation delivery preserves personalization on resend and enforces bounds", async () => {
	const owner = await actor();
	const org = await organization(owner);
	const email = `personalized-${randomUUID()}@example.invalid`;
	const body = {
		organizationId: org.id,
		email,
		role: "member" as const,
		recipientName: "Jane",
		message: "Welcome\naboard",
	};
	const created = await auth.api.createInvitation({
		headers: owner.headers,
		body,
	});
	expect(created).toMatchObject({
		recipientName: "Jane",
		message: "Welcome\naboard",
	});
	expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(
		3 * 24 * 60 * 60 * 1000 - 5000,
	);
	await auth.api.createInvitation({
		headers: owner.headers,
		body: {
			...body,
			recipientName: "Replacement",
			message: "Not used on resend",
			resend: true,
		},
	});
	const sent = invitationEmails.filter((entry) => entry.email === email);
	expect(sent).toHaveLength(2);
	for (const entry of sent)
		expect(entry).toMatchObject({
			recipientName: "Jane",
			message: "Welcome\naboard",
		});
	await expect(
		auth.api.createInvitation({
			headers: owner.headers,
			body: {
				...body,
				email: "too-long@example.invalid",
				message: "x".repeat(2001),
			},
		}),
	).rejects.toThrow("Invalid invitation name or message");
});

test("lists canonical safe member DTOs, excluding outsiders and unverified users", async () => {
	const owner = await actor();
	const collaborator = await actor();
	const outsider = await actor();
	const org = await organization(owner);
	const membership = await add(org.id, collaborator);
	const entries = data(
		await operations(collaborator.headers, (actor) =>
			memberDomain.listMembers(
				database.db,
				auth,
				collaborator.headers,
				actor,
				org.id,
			),
		),
	);
	expect(entries).toHaveLength(2);
	expect(entries.find((entry) => entry.id === membership.id)).toMatchObject({
		id: membership.id,
		userId: collaborator.userId,
		name: "",
		email: collaborator.email,
		role: "member",
		image: null,
		gravatarUrl: expect.stringMatching(
			/^https:\/\/gravatar.com\/avatar\/[a-f0-9]{64}\?d=404&s=64$/,
		),
		joinedAt: expect.any(Date),
	});
	expect(
		(
			await operations(new Headers(), (actor) =>
				memberDomain.listMembers(
					database.db,
					auth,
					new Headers(),
					actor,
					org.id,
				),
			)
		).error?.code,
	).toBe("UNAUTHENTICATED");
	expect(
		(
			await operations(outsider.headers, (actor) =>
				memberDomain.listMembers(
					database.db,
					auth,
					outsider.headers,
					actor,
					org.id,
				),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	await database.db
		.update(user)
		.set({ emailVerified: false })
		.where(eq(user.id, collaborator.userId));
	expect(
		(
			await operations(collaborator.headers, (actor) =>
				memberDomain.listMembers(
					database.db,
					auth,
					collaborator.headers,
					actor,
					org.id,
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
});

test("native role restrictions and tenant-qualified targets apply through member operations", async () => {
	const owner = await actor();
	const administrator = await actor();
	const collaborator = await actor();
	const org = await organization(owner);
	const adminMember = await add(org.id, administrator, "admin");
	const regular = await add(org.id, collaborator);
	const ownerMember = data(
		await operations(owner.headers, (actor) =>
			memberDomain.listMembers(database.db, auth, owner.headers, actor, org.id),
		),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	const ownerTarget = { organizationId: org.id, memberId: ownerMember.id };
	expect(
		(
			await operations(administrator.headers, (actor) =>
				memberDomain.updateRole(
					database.db,
					auth,
					administrator.headers,
					actor,
					{
						organizationId: org.id,
						memberId: adminMember.id,
						role: "owner",
					},
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations(administrator.headers, (actor) =>
				memberDomain.updateRole(
					database.db,
					auth,
					administrator.headers,
					actor,
					{
						...ownerTarget,
						role: "member",
					},
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations(administrator.headers, (actor) =>
				memberDomain.removeMember(
					database.db,
					auth,
					administrator.headers,
					actor,
					ownerTarget,
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations(collaborator.headers, (actor) =>
				memberDomain.updateRole(
					database.db,
					auth,
					collaborator.headers,
					actor,
					{
						organizationId: org.id,
						memberId: regular.id,
						role: "admin",
					},
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	const other = await organization(owner);
	const foreign = await add(other.id, collaborator);
	expect(
		(
			await operations(owner.headers, (actor) =>
				memberDomain.removeMember(database.db, auth, owner.headers, actor, {
					organizationId: org.id,
					memberId: foreign.id,
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await operations(owner.headers, (actor) =>
				memberDomain.updateRole(database.db, auth, owner.headers, actor, {
					organizationId: org.id,
					memberId: foreign.id,
					role: "admin",
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		data(
			await operations(administrator.headers, (actor) =>
				memberDomain.updateRole(
					database.db,
					auth,
					administrator.headers,
					actor,
					{
						organizationId: org.id,
						memberId: regular.id,
						role: "admin",
					},
				),
			),
		),
	).toEqual({ memberId: regular.id });
	expect(
		(
			await operations(owner.headers, (actor) =>
				memberDomain.leaveOrganization(
					database.db,
					auth,
					owner.headers,
					actor,
					org.id,
				),
			)
		).error,
	).toMatchObject({
		code: "CONFLICT",
		message: expect.stringContaining("promote another member"),
	});
	expect(
		(
			await operations(owner.headers, (actor) =>
				memberDomain.updateRole(database.db, auth, owner.headers, actor, {
					...ownerTarget,
					role: "member",
				}),
			)
		).error?.code,
	).toBe("CONFLICT");
	data(
		await operations(owner.headers, (actor) =>
			memberDomain.updateRole(database.db, auth, owner.headers, actor, {
				organizationId: org.id,
				memberId: regular.id,
				role: "owner",
			}),
		),
	);
	expect(
		(
			await operations(administrator.headers, (actor) =>
				memberDomain.removeMember(
					database.db,
					auth,
					administrator.headers,
					actor,
					ownerTarget,
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
});

test("effective project admins manage same-organization grants, revocation is immediate, implicit access survives", async () => {
	const owner = await actor();
	const manager = await actor();
	const viewer = await actor();
	const org = await organization(owner);
	const managerMember = await add(org.id, manager);
	const viewerMember = await add(org.id, viewer);
	const project = data(
		await operations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: org.id,
				name: "Private",
			}),
		),
	);
	const reference = { organizationId: org.id, projectId: project.id };
	data(
		await operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: managerMember.id,
				role: "admin",
			}),
		),
	);
	expect(
		data(
			await operations(manager.headers, (actor) =>
				memberDomain.listProjectGrantCandidates(
					database.db,
					auth,
					manager.headers,
					actor,
					reference,
				),
			),
		).map((entry) => entry.id),
	).toContain(viewerMember.id);
	expect(
		(
			await operations(viewer.headers, (actor) =>
				memberDomain.listProjectGrantCandidates(
					database.db,
					auth,
					viewer.headers,
					actor,
					reference,
				),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	data(
		await operations(manager.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: viewerMember.id,
				role: "viewer",
			}),
		),
	);
	expect(
		(
			await operations(viewer.headers, (actor) =>
				memberDomain.listProjectGrantCandidates(
					database.db,
					auth,
					viewer.headers,
					actor,
					reference,
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	const other = await organization(owner);
	const foreign = await add(other.id, viewer);
	expect(
		(
			await operations(manager.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: foreign.id,
					role: "admin",
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	const ownerMember = data(
		await operations(owner.headers, (actor) =>
			memberDomain.listMembers(database.db, auth, owner.headers, actor, org.id),
		),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	data(
		await operations(manager.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: ownerMember.id,
				role: "viewer",
			}),
		),
	);
	data(
		await operations(manager.headers, (actor) =>
			projectDomain.removeProjectMember(database.db, actor, {
				...reference,
				memberId: ownerMember.id,
			}),
		),
	);
	expect(
		data(
			await operations(owner.headers, (actor) =>
				projectDomain.getProject(database.db, actor, reference),
			),
		).role,
	).toBe("admin");
	data(
		await operations(owner.headers, (actor) =>
			memberDomain.removeMember(database.db, auth, owner.headers, actor, {
				organizationId: org.id,
				memberId: managerMember.id,
			}),
		),
	);
	expect(
		(
			await operations(manager.headers, (actor) =>
				memberDomain.listProjectGrantCandidates(
					database.db,
					auth,
					manager.headers,
					actor,
					reference,
				),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await operations(manager.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: viewerMember.id,
					role: "admin",
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		await database.db
			.select()
			.from(projectMember)
			.where(eq(projectMember.memberId, managerMember.id)),
	).toHaveLength(0);
});

test("self-demotion and native leave clear authority and cascade explicit grants", async () => {
	const owner = await actor();
	const administrator = await actor();
	const org = await organization(owner);
	const adminMember = await add(org.id, administrator, "admin");
	const project = data(
		await operations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: org.id,
				name: "Private",
			}),
		),
	);
	const reference = { organizationId: org.id, projectId: project.id };
	data(
		await operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: adminMember.id,
				role: "viewer",
			}),
		),
	);
	data(
		await operations(administrator.headers, (actor) =>
			memberDomain.updateRole(database.db, auth, administrator.headers, actor, {
				organizationId: org.id,
				memberId: adminMember.id,
				role: "member",
			}),
		),
	);
	expect(
		data(
			await operations(administrator.headers, (actor) =>
				projectDomain.getProject(database.db, actor, reference),
			),
		).role,
	).toBe("viewer");
	expect(
		(
			await operations(administrator.headers, (actor) =>
				memberDomain.removeMember(
					database.db,
					auth,
					administrator.headers,
					actor,
					{
						organizationId: org.id,
						memberId: adminMember.id,
					},
				),
			)
		).error?.code,
	).toBe("FORBIDDEN");
	await auth.api.setActiveOrganization({
		headers: administrator.headers,
		body: { organizationId: org.id },
	});
	data(
		await operations(administrator.headers, (actor) =>
			memberDomain.leaveOrganization(
				database.db,
				auth,
				administrator.headers,
				actor,
				org.id,
			),
		),
	);
	expect(
		(await auth.api.getSession({ headers: administrator.headers }))?.session
			.activeOrganizationId,
	).toBeNull();
	expect(
		await database.db
			.select()
			.from(projectMember)
			.where(eq(projectMember.memberId, adminMember.id)),
	).toHaveLength(0);
	expect(
		(
			await operations(administrator.headers, (actor) =>
				projectDomain.getProject(database.db, actor, reference),
			)
		).error?.code,
	).toBe("NOT_FOUND");
});

test("competing owner loss returns controlled errors and retains one canonical owner", async () => {
	const first = await actor();
	const second = await actor();
	const org = await organization(first);
	const secondMember = await add(org.id, second, "owner");
	const blocker = await database.pool.connect();
	await blocker.query("BEGIN");
	await blocker.query(
		"SELECT organization_id FROM app.organization_owner_guard WHERE organization_id = $1 FOR UPDATE",
		[org.id],
	);
	// Hold the integrity row so both native prechecks see two owners before either write completes.
	const competing = Promise.all([
		operations(first.headers, (actor) =>
			memberDomain.leaveOrganization(
				database.db,
				auth,
				first.headers,
				actor,
				org.id,
			),
		),
		operations(second.headers, (actor) =>
			memberDomain.updateRole(database.db, auth, second.headers, actor, {
				organizationId: org.id,
				memberId: secondMember.id,
				role: "member",
			}),
		),
	]);
	let blocked = false;
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			const result = await database.pool.query(
				"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
			);
			if (result.rows[0].count >= 2) {
				blocked = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
	}
	const outcomes = await competing;
	expect(blocked).toBe(true);
	expect(outcomes.filter((entry) => !entry.error)).toHaveLength(1);
	expect(
		outcomes.filter((entry) => entry.error).map((entry) => entry.error?.code),
	).toEqual(["CONFLICT"]);
	expect(
		await database.db
			.select()
			.from(member)
			.where(and(eq(member.organizationId, org.id), eq(member.role, "owner"))),
	).toHaveLength(1);
});
