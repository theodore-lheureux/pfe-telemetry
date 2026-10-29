import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { createAuth } from "../../src/auth/create-auth.server";
import { createCollectorCredentialRequests } from "../../src/credentials/credentials.server";
import { createDatabase } from "../../src/db/client.server";
import { collectorCredential, project, user } from "../../src/db/schema";
import type {
	OperationResult,
	ProjectReference,
} from "../../src/organizations/contracts";
import type { OperationErrorCode } from "../../src/organizations/errors";
import { createOrganizationRequests } from "../../src/organizations/request.server";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_URL is required");
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const origin = "http://localhost:3001";
let databaseName: string;
let database: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let organizations: ReturnType<typeof createOrganizationRequests>;
let credentials: ReturnType<typeof createCollectorCredentialRequests>;
let owner: Awaited<ReturnType<typeof actor>>;
let reference: ProjectReference;
let links: Map<string, string>;
let actorCount: number;

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	const email = `collector-admin-${++actorCount}@example.invalid`;
	const response = await auth.handler(
		new Request(`${origin}/api/auth/sign-in/magic-link`, {
			method: "POST",
			headers: {
				origin,
				"content-type": "application/json",
				"x-forwarded-for": `192.0.2.${actorCount}`,
			},
			body: JSON.stringify({ email, callbackURL: "/account" }),
		}),
	);
	expect(response.status).toBe(200);
	const link = links.get(email);
	if (!link) throw new Error("Expected intercepted test sign-in link");
	const signedIn = await auth.handler(new Request(link));
	const headers = new Headers({
		origin,
		cookie: signedIn.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; "),
	});
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error("Expected test session");
	return { headers, userId: session.user.id };
}

beforeEach(async () => {
	databaseName = `pfe_credentials_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	await applyMigrations(url.toString());
	// Replay must be a no-op, including the custom constraint functions.
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 4 });
	links = new Map();
	actorCount = 0;
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `test-only-credential-secret-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInLink: async (email, link) => {
				links.set(email, link);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	organizations = createOrganizationRequests(database.db, auth);
	credentials = createCollectorCredentialRequests(database.db, auth);
	owner = await actor();
	const organization = data(
		await organizations.createOrganization(owner.headers, {
			name: "Collectors",
			slug: "collectors",
		}),
	);
	const project = data(
		await organizations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Private",
			slug: "private",
		}),
	);
	reference = { organizationId: organization.id, projectId: project.id };
}, 30_000);

afterEach(async () => {
	await database?.pool.end();
	await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
}, 30_000);
afterAll(async () => {
	await admin.end();
});

function input() {
	return {
		...reference,
		name: "Build collector",
		sourceId: "builds",
		hosts: ["node-1"],
	};
}

function digest(token: string) {
	return createHash("sha256").update(token, "ascii").digest("hex");
}

// Exercise the live SQL contract consumed by ingestion, not a second auth implementation.
async function lookup(token: string) {
	const id = token.split("_")[1];
	const result = await database.pool.query(
		`SELECT project_id, source_id, hosts, require_host_id, maximum_submission_age, allowed_clock_skew
		 FROM ingestion.collector_credential WHERE id = $1 AND token_sha256 = $2
		 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
		[id, digest(token)],
	);
	return result.rows;
}

test("reveals strong secrets only at creation/rotation and changes live ingestion state", async () => {
	const created = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	expect(created.token).toMatch(
		new RegExp(`^pfe_${created.credential.id}_[A-Za-z0-9_-]{43}$`),
	);
	expect(created.credential).toMatchObject({
		...input(),
		requireHostId: true,
		maximumSubmissionAge: 3600,
		allowedClockSkew: 60,
		revokedAt: null,
		expiresAt: null,
		rotatedAt: null,
	});
	const [stored] = await database.db.select().from(collectorCredential);
	expect(stored.tokenSha256).toBe(digest(created.token));
	expect(JSON.stringify(stored)).not.toContain(created.token);
	expect(await lookup(created.token)).toEqual([
		{
			project_id: reference.projectId,
			source_id: "builds",
			hosts: ["node-1"],
			require_host_id: true,
			maximum_submission_age: 3600,
			allowed_clock_skew: 60,
		},
	]);
	const ref = { ...reference, credentialId: created.credential.id };
	const rotated = data(
		await credentials.rotateCollectorCredential(owner.headers, ref),
	);
	expect(rotated.token).not.toBe(created.token);
	expect(rotated.credential.id).toBe(created.credential.id);
	expect(rotated.credential.rotatedAt).not.toBeNull();
	expect(await lookup(created.token)).toEqual([]);
	expect(await lookup(rotated.token)).toHaveLength(1);
	const listed = data(
		await credentials.listCollectorCredentials(owner.headers, reference),
	);
	expect(listed).toEqual([rotated.credential]);
	expect(Object.keys(listed[0])).not.toContain("tokenSha256");
	expect(Object.keys(listed[0])).not.toContain("token");
	const revoked = data(
		await credentials.revokeCollectorCredential(owner.headers, ref),
	);
	expect(revoked.revokedAt).not.toBeNull();
	expect(
		data(await credentials.revokeCollectorCredential(owner.headers, ref)),
	).toEqual(revoked);
	expect(await lookup(rotated.token)).toEqual([]);
	expect(
		(await credentials.rotateCollectorCredential(owner.headers, ref)).error
			?.code,
	).toBe("NOT_FOUND");
	expect(JSON.stringify(revoked)).not.toContain("token");
});

test("only verified effective project admins can list, create, rotate or revoke", async () => {
	const collaborator = await actor();
	const membership = await auth.api.addMember({
		body: {
			organizationId: reference.organizationId,
			userId: collaborator.userId,
			role: "member",
		},
	});
	const created = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	async function denied(headers: Headers, code: OperationErrorCode) {
		expect(
			(await credentials.listCollectorCredentials(headers, reference)).error
				?.code,
		).toBe(code);
		expect(
			(await credentials.createCollectorCredential(headers, input())).error
				?.code,
		).toBe(code);
		expect(
			(await credentials.rotateCollectorCredential(headers, ref)).error?.code,
		).toBe(code);
		expect(
			(await credentials.revokeCollectorCredential(headers, ref)).error?.code,
		).toBe(code);
	}
	await denied(new Headers(), "UNAUTHENTICATED");
	await denied(collaborator.headers, "NOT_FOUND");
	for (const role of ["viewer", "member"] as const) {
		data(
			await organizations.setProjectMember(owner.headers, {
				...reference,
				memberId: membership.id,
				role,
			}),
		);
		await denied(collaborator.headers, "FORBIDDEN");
	}
	data(
		await organizations.setProjectMember(owner.headers, {
			...reference,
			memberId: membership.id,
			role: "admin",
		}),
	);
	expect(
		data(
			await credentials.listCollectorCredentials(
				collaborator.headers,
				reference,
			),
		),
	).toHaveLength(1);
	data(await credentials.rotateCollectorCredential(collaborator.headers, ref));
	const explicitAdminCredential = data(
		await credentials.createCollectorCredential(collaborator.headers, input()),
	);
	data(
		await credentials.revokeCollectorCredential(collaborator.headers, {
			...reference,
			credentialId: explicitAdminCredential.credential.id,
		}),
	);
	// Organization admin access overrides an explicit viewer grant.
	await auth.api.updateMemberRole({
		headers: owner.headers,
		body: {
			organizationId: reference.organizationId,
			memberId: membership.id,
			role: "admin",
		},
	});
	data(
		await organizations.setProjectMember(owner.headers, {
			...reference,
			memberId: membership.id,
			role: "viewer",
		}),
	);
	const second = data(
		await credentials.createCollectorCredential(collaborator.headers, {
			...input(),
			sourceId: "second",
		}),
	);
	data(
		await credentials.revokeCollectorCredential(collaborator.headers, {
			...reference,
			credentialId: second.credential.id,
		}),
	);
	await database.db
		.update(user)
		.set({ emailVerified: false })
		.where(eq(user.id, collaborator.userId));
	await denied(collaborator.headers, "FORBIDDEN");
	await database.db
		.update(user)
		.set({ emailVerified: true })
		.where(eq(user.id, collaborator.userId));
	await auth.api.removeMember({
		headers: owner.headers,
		body: {
			organizationId: reference.organizationId,
			memberIdOrEmail: membership.id,
		},
	});
	await denied(collaborator.headers, "NOT_FOUND");
});

test("credential IDs cannot cross projects or organizations and SQL enforces tenant keys", async () => {
	const created = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	const otherProject = data(
		await organizations.createProject(owner.headers, {
			organizationId: reference.organizationId,
			name: "Other",
			slug: "other",
		}),
	);
	const otherOrg = data(
		await organizations.createOrganization(owner.headers, {
			name: "Other",
			slug: "other-org",
		}),
	);
	for (const wrong of [
		{ ...reference, projectId: otherProject.id },
		{ ...reference, organizationId: otherOrg.id },
	]) {
		const ref = { ...wrong, credentialId: created.credential.id };
		expect(
			(await credentials.rotateCollectorCredential(owner.headers, ref)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			(await credentials.revokeCollectorCredential(owner.headers, ref)).error
				?.code,
		).toBe("NOT_FOUND");
	}
	expect(
		data(
			await credentials.listCollectorCredentials(owner.headers, {
				...reference,
				projectId: otherProject.id,
			}),
		),
	).toEqual([]);
	expect(
		(
			await credentials.createCollectorCredential(owner.headers, {
				...input(),
				organizationId: otherOrg.id,
			})
		).error?.code,
	).toBe("NOT_FOUND");
	const outsider = await actor();
	expect(
		(await credentials.listCollectorCredentials(outsider.headers, reference))
			.error?.code,
	).toBe("NOT_FOUND");
	await expect(
		database.db
			.update(collectorCredential)
			.set({ organizationId: otherOrg.id })
			.where(eq(collectorCredential.id, created.credential.id))
			.execute(),
	).rejects.toMatchObject({ cause: { code: "23503" } });
	expect(await lookup(created.token)).toHaveLength(1);
});

test("expiration is enforced by live lookup and rotation, with no immortal replacement", async () => {
	expect(
		(
			await credentials.createCollectorCredential(owner.headers, {
				...input(),
				expiresAt: "2000-01-01T00:00:00Z",
			})
		).error?.code,
	).toBe("INVALID_INPUT");
	const expiresAt = new Date(Date.now() + 60_000).toISOString();
	const created = data(
		await credentials.createCollectorCredential(owner.headers, {
			...input(),
			expiresAt,
		}),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	const rotated = data(
		await credentials.rotateCollectorCredential(owner.headers, ref),
	);
	expect(rotated.credential.expiresAt).toEqual(new Date(expiresAt));
	await database.db
		.update(collectorCredential)
		.set({
			createdAt: new Date("2000-01-01"),
			expiresAt: new Date("2001-01-01"),
		})
		.where(eq(collectorCredential.id, ref.credentialId));
	expect(await lookup(rotated.token)).toEqual([]);
	expect(
		(await credentials.rotateCollectorCredential(owner.headers, ref)).error
			?.code,
	).toBe("NOT_FOUND");
	expect(
		data(
			await credentials.listCollectorCredentials(owner.headers, reference),
		)[0].expiresAt,
	).toEqual(new Date("2001-01-01T00:00:00.000Z"));
	data(await credentials.revokeCollectorCredential(owner.headers, ref));
});

test("creation checks expiry at insertion after a pre-insert delay", async () => {
	const expiresAt = new Date(Date.now() + 500).toISOString();
	const randomBytes = crypto.randomBytes;
	const delayedSecret = spyOn(crypto, "randomBytes").mockImplementationOnce(
		(size: number) => {
			Bun.sleepSync(750);
			return randomBytes(size);
		},
	);
	try {
		expect(
			(
				await credentials.createCollectorCredential(owner.headers, {
					...input(),
					expiresAt,
				})
			).error?.code,
		).toBe("INVALID_INPUT");
		expect(delayedSecret).toHaveBeenCalled();
		expect(await database.db.select().from(collectorCredential)).toEqual([]);
	} finally {
		delayedSecret.mockRestore();
	}
});

test("SQL protects enrollment policy and digest even outside application validation", async () => {
	const created = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	for (const patch of [
		{ sourceId: "" },
		{ sourceId: "é".repeat(65) },
		{ sourceId: "bad\u0085source" },
		{ hosts: [] },
		{ hosts: ["bad\nnode"] },
		{ hosts: ["node", "node"] },
		{ hosts: Array(257).fill("node") },
		{ hosts: [null] as unknown as string[] },
		{ maximumSubmissionAge: 0 },
		{ allowedClockSkew: 3601 },
		{ tokenSha256: "not-a-digest" },
		{ expiresAt: new Date("2000-01-01") },
	]) {
		await expect(
			database.db
				.update(collectorCredential)
				.set(patch)
				.where(eq(collectorCredential.id, created.credential.id))
				.execute(),
		).rejects.toMatchObject({ cause: { code: "23514" } });
	}
	const optionalHost = data(
		await credentials.createCollectorCredential(owner.headers, {
			...input(),
			hosts: [],
			requireHostId: false,
		}),
	);
	expect(optionalHost.credential.hosts).toEqual([]);
	// Source identity is project-scoped, and multiple independently revocable installations are allowed.
	const another = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	expect(another.credential.sourceId).toBe(created.credential.sourceId);
	expect(another.token).not.toBe(created.token);
	await expect(
		database.db
			.update(collectorCredential)
			.set({ tokenSha256: digest(created.token) })
			.where(eq(collectorCredential.id, another.credential.id))
			.execute(),
	).rejects.toMatchObject({ cause: { code: "23505" } });
});

test("rotation cannot undo concurrent revocation, and deleting a project removes its credentials", async () => {
	const created = data(
		await credentials.createCollectorCredential(owner.headers, input()),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	const [rotation, revocation] = await Promise.all([
		credentials.rotateCollectorCredential(owner.headers, ref),
		credentials.revokeCollectorCredential(owner.headers, ref),
	]);
	expect(revocation.error).toBeNull();
	if (rotation.data) expect(await lookup(rotation.data.token)).toEqual([]);
	else expect(rotation.error.code).toBe("NOT_FOUND");
	expect(await lookup(created.token)).toEqual([]);
	expect(
		(await credentials.rotateCollectorCredential(owner.headers, ref)).error
			?.code,
	).toBe("NOT_FOUND");
	await database.db.delete(project).where(eq(project.id, reference.projectId));
	expect(await database.db.select().from(collectorCredential)).toEqual([]);
});
