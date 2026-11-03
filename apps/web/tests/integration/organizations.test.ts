import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { createAuth } from "../../src/auth/create-auth.server";
import { createDatabase } from "../../src/db/client.server";
import {
	invitation,
	member,
	organizationOwnerGuard,
	projectMember,
	user,
} from "../../src/db/schema";
import { resolveOrganizationRole } from "../../src/organizations/access.server";
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
const origin = "http://localhost:3001";
let databaseName: string;
let database: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let operations: ReturnType<typeof createOrganizationRequests>;
let links: Map<string, string>;
let actorCount: number;

beforeEach(async () => {
	databaseName = `pfe_org_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 4 });
	links = new Map();
	actorCount = 0;
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `test-only-organization-secret-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		async (email, url) => {
			links.set(email, url);
		},
	);
	operations = createOrganizationRequests(database.db, auth);
});

afterEach(async () => {
	await database?.pool.end();
	await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
});
afterAll(async () => {
	await admin.end();
});

function post(path: string, body: unknown, headers = new Headers()) {
	return new Request(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			...Object.fromEntries(headers),
			origin,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	actorCount++;
	const email = `user-${actorCount}@example.invalid`;
	const requested = await auth.handler(
		post(
			"/sign-in/magic-link",
			{ email, callbackURL: "/account" },
			new Headers({ "x-forwarded-for": `192.0.2.${actorCount}` }),
		),
	);
	expect(requested.status).toBe(200);
	const link = links.get(email);
	if (!link) throw new Error("Expected test sign-in link");
	const signedIn = await auth.handler(new Request(link));
	const cookie = signedIn.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	const headers = new Headers({ cookie, origin });
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected test session");
	return { headers, userId: session.user.id, email };
}

async function createOrganization(
	owner: Awaited<ReturnType<typeof actor>>,
	slug = "test-org",
) {
	return data(
		await operations.createOrganization(owner.headers, {
			name: "Test organization",
			slug,
		}),
	);
}

async function addMember(
	organizationId: string,
	person: Awaited<ReturnType<typeof actor>>,
	role: OrganizationRole = "member",
) {
	return auth.api.addMember({
		body: { organizationId, userId: person.userId, role },
	});
}

describe("organization and project boundaries", () => {
	test("uses canonical memberships and requires verified sessions", async () => {
		const owner = await actor();
		const outsider = await actor();
		const organization = await createOrganization(owner);
		expect(organization.role).toBe("owner");
		expect(
			(
				await operations.createOrganization(owner.headers, {
					name: "Duplicate",
					slug: organization.slug,
				})
			).error?.code,
		).toBe("CONFLICT");
		expect(data(await operations.listOrganizations(owner.headers))).toEqual([
			organization,
		]);
		expect(data(await operations.listOrganizations(outsider.headers))).toEqual(
			[],
		);
		expect(
			(await operations.getOrganization(outsider.headers, organization.id))
				.error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations.createOrganization(new Headers(), {
					name: "Denied",
					slug: "denied",
				})
			).error?.code,
		).toBe("UNAUTHENTICATED");
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, outsider.userId));
		expect(
			(
				await operations.createOrganization(outsider.headers, {
					name: "Denied",
					slug: "denied",
				})
			).error?.code,
		).toBe("FORBIDDEN");
		const invalid = await auth.handler(
			post(
				"/organization/create",
				{ name: "Bad", slug: "invalid slug" },
				owner.headers,
			),
		);
		expect(invalid.status).toBe(400);
	});

	test("keeps projects private and enforces effective role precedence", async () => {
		const owner = await actor();
		const collaborator = await actor();
		const administrator = await actor();
		const organization = await createOrganization(owner);
		const collaboratorMember = await addMember(organization.id, collaborator);
		const adminMember = await addMember(
			organization.id,
			administrator,
			"admin",
		);
		const project = data(
			await operations.createProject(owner.headers, {
				organizationId: organization.id,
				name: "Private project",
				slug: "private-project",
			}),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		expect(
			data(
				await operations.listProjects(collaborator.headers, organization.id),
			),
		).toEqual([]);
		expect(
			(await operations.getProject(collaborator.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations.createProject(collaborator.headers, {
					organizationId: organization.id,
					name: "Denied",
					slug: "denied",
				})
			).error?.code,
		).toBe("FORBIDDEN");
		for (const role of ["viewer", "member"] as const) {
			data(
				await operations.setProjectMember(owner.headers, {
					...reference,
					memberId: collaboratorMember.id,
					role,
				}),
			);
			expect(
				data(await operations.getProject(collaborator.headers, reference)).role,
			).toBe(role);
			expect(
				(
					await operations.updateProject(collaborator.headers, {
						...reference,
						name: "Denied",
					})
				).error?.code,
			).toBe("FORBIDDEN");
			expect(
				(
					await operations.setProjectMember(collaborator.headers, {
						...reference,
						memberId: collaboratorMember.id,
						role: "admin",
					})
				).error?.code,
			).toBe("FORBIDDEN");
		}
		data(
			await operations.setProjectMember(owner.headers, {
				...reference,
				memberId: collaboratorMember.id,
				role: "admin",
			}),
		);
		expect(
			data(
				await operations.updateProject(collaborator.headers, {
					...reference,
					name: "Updated",
				}),
			).name,
		).toBe("Updated");
		data(
			await operations.setProjectMember(owner.headers, {
				...reference,
				memberId: adminMember.id,
				role: "viewer",
			}),
		);
		expect(
			data(await operations.getProject(administrator.headers, reference)).role,
		).toBe("admin");
		expect(
			(
				await operations.createProject(owner.headers, {
					organizationId: organization.id,
					name: "Duplicate",
					slug: project.slug,
				})
			).error?.code,
		).toBe("CONFLICT");
		const second = await createOrganization(owner, "second-org");
		expect(
			data(
				await operations.createProject(owner.headers, {
					organizationId: second.id,
					name: "Independent",
					slug: project.slug,
				}),
			).organizationId,
		).toBe(second.id);
		expect(
			(
				await operations.getProject(owner.headers, {
					...reference,
					organizationId: second.id,
				})
			).error?.code,
		).toBe("NOT_FOUND");
	});

	test("enforces tenant-qualified membership keys and revocation", async () => {
		const owner = await actor();
		const collaborator = await actor();
		const outsider = await actor();
		const organization = await createOrganization(owner);
		const second = await createOrganization(outsider, "outside-org");
		const collaboratorMember = await addMember(organization.id, collaborator);
		const [outsideMember] = await database.db
			.select()
			.from(member)
			.where(eq(member.organizationId, second.id));
		const project = data(
			await operations.createProject(owner.headers, {
				organizationId: organization.id,
				name: "Project",
				slug: "project",
			}),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		expect(
			(
				await operations.setProjectMember(owner.headers, {
					...reference,
					memberId: outsideMember.id,
					role: "viewer",
				})
			).error?.code,
		).toBe("NOT_FOUND");
		await expect(
			database.db
				.insert(projectMember)
				.values({ ...reference, memberId: outsideMember.id, role: "viewer" })
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23503" } });
		expect(
			(
				await operations.removeProjectMember(owner.headers, {
					...reference,
					memberId: outsideMember.id,
				})
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			data(
				await operations.removeProjectMember(owner.headers, {
					...reference,
					memberId: collaboratorMember.id,
				}),
			),
		).toEqual({ removed: true });
		await expect(
			database.db
				.insert(projectMember)
				.values({
					projectId: project.id,
					organizationId: second.id,
					memberId: outsideMember.id,
					role: "viewer",
				})
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23503" } });
		await expect(
			database.db
				.insert(member)
				.values({ ...collaboratorMember, id: "duplicate-membership" })
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23505" } });
		data(
			await operations.setProjectMember(owner.headers, {
				...reference,
				memberId: collaboratorMember.id,
				role: "viewer",
			}),
		);
		await auth.api.removeMember({
			headers: owner.headers,
			body: {
				organizationId: organization.id,
				memberIdOrEmail: collaboratorMember.id,
			},
		});
		expect(
			(await operations.getProject(collaborator.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(await database.db.select().from(projectMember)).toHaveLength(0);
		await addMember(organization.id, collaborator);
		expect(
			(await operations.getProject(collaborator.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		await auth.handler(post("/sign-out", {}, collaborator.headers));
		expect(
			(await operations.getProject(collaborator.headers, reference)).error
				?.code,
		).toBe("UNAUTHENTICATED");
	});

	test("rejects native admin promotion and last-owner removal", async () => {
		const owner = await actor();
		const administrator = await actor();
		const organization = await createOrganization(owner);
		const adminMember = await addMember(
			organization.id,
			administrator,
			"admin",
		);
		const promotion = await auth.handler(
			post(
				"/organization/update-member-role",
				{
					organizationId: organization.id,
					memberId: adminMember.id,
					role: "owner",
				},
				administrator.headers,
			),
		);
		expect(promotion.status).toBe(403);
		const [ownerMember] = await database.db
			.select()
			.from(member)
			.where(eq(member.userId, owner.userId));
		await expect(
			database.db
				.update(member)
				.set({ role: "member" })
				.where(eq(member.id, ownerMember.id))
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23514" } });
		const deletion = await auth.handler(
			post(
				"/organization/delete",
				{ organizationId: organization.id },
				owner.headers,
			),
		);
		expect(deletion.status).toBe(404);
		expect(
			(await database.db.select().from(organizationOwnerGuard))[0].ownerCount,
		).toBe(1);
	});

	test("rejects malformed native invitation grants while allowing owner invitations", async () => {
		const owner = await actor();
		const administrator = await actor();
		const invited = await actor();
		const organization = await createOrganization(owner);
		await addMember(organization.id, administrator, "admin");
		const denied = await auth.handler(
			post(
				"/organization/invite-member",
				{
					organizationId: organization.id,
					email: invited.email,
					role: "admin, owner",
				},
				administrator.headers,
			),
		);
		expect(denied.status).toBe(400);
		expect(await database.db.select().from(invitation)).toHaveLength(0);
		const created = await auth.api.createInvitation({
			headers: owner.headers,
			body: {
				organizationId: organization.id,
				email: invited.email,
				role: "owner",
			},
		});
		await auth.api.acceptInvitation({
			headers: invited.headers,
			body: { invitationId: created.id },
		});
		expect(
			data(await operations.getOrganization(invited.headers, organization.id))
				.role,
		).toBe("owner");
	});

	test("serializes competing owner loss and blocks user-delete cascades", async () => {
		const first = await actor();
		const second = await actor();
		const organization = await createOrganization(first);
		await addMember(organization.id, second, "owner");
		await database.db
			.update(member)
			.set({ role: "\tmember, owner\t" })
			.where(eq(member.userId, second.userId));
		expect(
			(await database.db.select().from(organizationOwnerGuard))[0].ownerCount,
		).toBe(2);
		expect(
			data(await operations.getOrganization(second.headers, organization.id))
				.role,
		).toBe("owner");
		const outcomes = await Promise.allSettled([
			database.db
				.update(member)
				.set({ role: "member" })
				.where(eq(member.userId, first.userId)),
			database.db.delete(member).where(eq(member.userId, second.userId)),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		const remaining = (await database.db.select().from(member)).filter(
			(entry) => resolveOrganizationRole(entry.role) === "owner",
		);
		expect(remaining).toHaveLength(1);
		expect(
			(await database.db.select().from(organizationOwnerGuard))[0].ownerCount,
		).toBe(1);
		await expect(
			database.db
				.delete(user)
				.where(eq(user.id, remaining[0].userId))
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23514" } });
		expect(
			(await database.db.select().from(member)).filter(
				(entry) => resolveOrganizationRole(entry.role) === "owner",
			),
		).toHaveLength(1);
	});
});
