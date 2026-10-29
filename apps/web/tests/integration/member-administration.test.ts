import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { createAuth } from "../../src/auth/create-auth.server";
import { createDatabase } from "../../src/db/client.server";
import { member, projectMember, user } from "../../src/db/schema";
import type {
	OperationResult,
	OrganizationRole,
} from "../../src/organizations/contracts";
import { createOrganizationRequests } from "../../src/organizations/request.server";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_URL is required");
const admin = new Pool({
	connectionString: adminUrl,
	max: 1,
	connectionTimeoutMillis: 5000,
});
const databaseName = `pfe_members_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3062";
let database: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let operations: ReturnType<typeof createOrganizationRequests>;
const links = new Map<string, string>();
let sequence = 0;

beforeAll(async () => {
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 6 });
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `member-test-only-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInLink: async (email, url) => {
				links.set(email, url);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	operations = createOrganizationRequests(database.db, auth);
});

afterAll(async () => {
	await database?.pool.end();
	await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
	await admin.end();
});

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	const id = ++sequence;
	const email = `member-${id}@example.invalid`;
	await auth.handler(
		new Request(`${origin}/api/auth/sign-in/magic-link`, {
			method: "POST",
			headers: {
				origin,
				"content-type": "application/json",
				"x-forwarded-for": `192.0.2.${id}`,
			},
			body: JSON.stringify({ email, callbackURL: "/" }),
		}),
	);
	const link = links.get(email);
	if (!link) throw new Error("Expected captured sign-in email");
	const response = await auth.handler(
		new Request(link, { headers: { "x-forwarded-for": `192.0.2.${id}` } }),
	);
	const headers = new Headers({
		origin,
		cookie: response.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; "),
	});
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected session");
	return { userId: session.user.id, email, headers };
}

async function organization(owner: Awaited<ReturnType<typeof actor>>) {
	return data(
		await operations.createOrganization(owner.headers, {
			name: "Members test",
			slug: `members-${randomUUID()}`,
		}),
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

test("lists canonical safe member DTOs, excluding outsiders and unverified users", async () => {
	const owner = await actor();
	const collaborator = await actor();
	const outsider = await actor();
	const org = await organization(owner);
	const membership = await add(org.id, collaborator);
	const entries = data(
		await operations.listOrganizationMembers(collaborator.headers, org.id),
	);
	expect(entries).toHaveLength(2);
	expect(entries.find((entry) => entry.id === membership.id)).toEqual({
		id: membership.id,
		userId: collaborator.userId,
		name: "",
		email: collaborator.email,
		role: "member",
	});
	expect(
		(await operations.listOrganizationMembers(new Headers(), org.id)).error
			?.code,
	).toBe("UNAUTHENTICATED");
	expect(
		(await operations.listOrganizationMembers(outsider.headers, org.id)).error
			?.code,
	).toBe("NOT_FOUND");
	await database.db
		.update(user)
		.set({ emailVerified: false })
		.where(eq(user.id, collaborator.userId));
	expect(
		(await operations.listOrganizationMembers(collaborator.headers, org.id))
			.error?.code,
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
		await operations.listOrganizationMembers(owner.headers, org.id),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	const ownerTarget = { organizationId: org.id, memberId: ownerMember.id };
	expect(
		(
			await operations.updateOrganizationMemberRole(administrator.headers, {
				organizationId: org.id,
				memberId: adminMember.id,
				role: "owner",
			})
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations.updateOrganizationMemberRole(administrator.headers, {
				...ownerTarget,
				role: "member",
			})
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations.removeOrganizationMember(
				administrator.headers,
				ownerTarget,
			)
		).error?.code,
	).toBe("FORBIDDEN");
	expect(
		(
			await operations.updateOrganizationMemberRole(collaborator.headers, {
				organizationId: org.id,
				memberId: regular.id,
				role: "admin",
			})
		).error?.code,
	).toBe("FORBIDDEN");
	const other = await organization(owner);
	const foreign = await add(other.id, collaborator);
	expect(
		(
			await operations.removeOrganizationMember(owner.headers, {
				organizationId: org.id,
				memberId: foreign.id,
			})
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await operations.updateOrganizationMemberRole(owner.headers, {
				organizationId: org.id,
				memberId: foreign.id,
				role: "admin",
			})
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		data(
			await operations.updateOrganizationMemberRole(administrator.headers, {
				organizationId: org.id,
				memberId: regular.id,
				role: "admin",
			}),
		),
	).toEqual({ memberId: regular.id });
	expect(
		(await operations.leaveOrganization(owner.headers, org.id)).error,
	).toMatchObject({
		code: "CONFLICT",
		message: expect.stringContaining("promote another member"),
	});
	expect(
		(
			await operations.updateOrganizationMemberRole(owner.headers, {
				...ownerTarget,
				role: "member",
			})
		).error?.code,
	).toBe("CONFLICT");
	data(
		await operations.updateOrganizationMemberRole(owner.headers, {
			organizationId: org.id,
			memberId: regular.id,
			role: "owner",
		}),
	);
	expect(
		(
			await operations.removeOrganizationMember(
				administrator.headers,
				ownerTarget,
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
		await operations.createProject(owner.headers, {
			organizationId: org.id,
			name: "Private",
			slug: "private",
		}),
	);
	const reference = { organizationId: org.id, projectId: project.id };
	data(
		await operations.setProjectMember(owner.headers, {
			...reference,
			memberId: managerMember.id,
			role: "admin",
		}),
	);
	expect(
		data(
			await operations.listProjectGrantCandidates(manager.headers, reference),
		).map((entry) => entry.id),
	).toContain(viewerMember.id);
	expect(
		(await operations.listProjectGrantCandidates(viewer.headers, reference))
			.error?.code,
	).toBe("NOT_FOUND");
	data(
		await operations.setProjectMember(manager.headers, {
			...reference,
			memberId: viewerMember.id,
			role: "viewer",
		}),
	);
	expect(
		(await operations.listProjectGrantCandidates(viewer.headers, reference))
			.error?.code,
	).toBe("FORBIDDEN");
	const other = await organization(owner);
	const foreign = await add(other.id, viewer);
	expect(
		(
			await operations.setProjectMember(manager.headers, {
				...reference,
				memberId: foreign.id,
				role: "admin",
			})
		).error?.code,
	).toBe("NOT_FOUND");
	const ownerMember = data(
		await operations.listOrganizationMembers(owner.headers, org.id),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	data(
		await operations.setProjectMember(manager.headers, {
			...reference,
			memberId: ownerMember.id,
			role: "viewer",
		}),
	);
	data(
		await operations.removeProjectMember(manager.headers, {
			...reference,
			memberId: ownerMember.id,
		}),
	);
	expect(data(await operations.getProject(owner.headers, reference)).role).toBe(
		"admin",
	);
	data(
		await operations.removeOrganizationMember(owner.headers, {
			organizationId: org.id,
			memberId: managerMember.id,
		}),
	);
	expect(
		(await operations.listProjectGrantCandidates(manager.headers, reference))
			.error?.code,
	).toBe("NOT_FOUND");
	expect(
		(
			await operations.setProjectMember(manager.headers, {
				...reference,
				memberId: viewerMember.id,
				role: "admin",
			})
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
		await operations.createProject(owner.headers, {
			organizationId: org.id,
			name: "Private",
			slug: "private",
		}),
	);
	const reference = { organizationId: org.id, projectId: project.id };
	data(
		await operations.setProjectMember(owner.headers, {
			...reference,
			memberId: adminMember.id,
			role: "viewer",
		}),
	);
	data(
		await operations.updateOrganizationMemberRole(administrator.headers, {
			organizationId: org.id,
			memberId: adminMember.id,
			role: "member",
		}),
	);
	expect(
		data(await operations.getProject(administrator.headers, reference)).role,
	).toBe("viewer");
	expect(
		(
			await operations.removeOrganizationMember(administrator.headers, {
				organizationId: org.id,
				memberId: adminMember.id,
			})
		).error?.code,
	).toBe("FORBIDDEN");
	await auth.api.setActiveOrganization({
		headers: administrator.headers,
		body: { organizationId: org.id },
	});
	data(await operations.leaveOrganization(administrator.headers, org.id));
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
		(await operations.getProject(administrator.headers, reference)).error?.code,
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
		operations.leaveOrganization(first.headers, org.id),
		operations.updateOrganizationMemberRole(second.headers, {
			organizationId: org.id,
			memberId: secondMember.id,
			role: "member",
		}),
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
