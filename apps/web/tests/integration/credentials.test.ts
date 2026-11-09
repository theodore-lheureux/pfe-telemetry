import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import * as credentialDomain from "../../src/credentials/credentials.server";
import {
	collectorCredential,
	collectorResourceGrant,
	collectorRootGrant,
	project,
	user,
} from "../../src/db/schema";
import type {
	OperationResult,
	ProjectReference,
} from "../../src/organizations/contracts";
import type { OperationErrorCode } from "../../src/organizations/errors";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";

const origin = "http://localhost:3001";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let organizations: ReturnType<typeof actorService>;
let credentials: ReturnType<typeof actorService>;
let owner: Awaited<ReturnType<typeof actor>>;
let reference: ProjectReference;
let codes: Map<string, string>;
let actorCount: number;

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function actor() {
	const email = `collector-admin-${++actorCount}@example.invalid`;
	const signedIn = await trustedCodeSignIn(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
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
	database = await createTestDatabase("credentials");
	codes = new Map();
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
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	organizations = actorService(auth);
	credentials = actorService(auth);
	owner = await actor();
	const organization = data(
		await organizations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Collectors",
				slug: "collectors",
			}),
		),
	);
	const project = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Private",
				slug: "private",
			}),
		),
	);
	reference = { organizationId: organization.id, projectId: project.id };
}, 30_000);

afterEach(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
}, 30_000);

function input() {
	return {
		...reference,
		name: "Build collector",
		sourceId: "builds",
		rootId: "node-1",
	};
}

function digest(token: string) {
	return createHash("sha256").update(token, "ascii").digest("hex");
}

// Exercise the live SQL contract consumed by ingestion, not a second auth implementation.
async function lookup(token: string) {
	const id = token.split("_")[1];
	const result = await database.pool.query(
		`SELECT project_id, source_id, root_id, root_kind, maximum_submission_age, allowed_clock_skew
		 FROM ingestion.collector_credential WHERE id = $1 AND token_sha256 = $2
		 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
		[id, digest(token)],
	);
	return result.rows;
}

test("reveals strong secrets only at creation/rotation and changes live ingestion state", async () => {
	const created = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	expect(created.token).toMatch(
		new RegExp(`^recount_${created.credential.id}_[A-Za-z0-9_-]{43}$`),
	);
	expect(created.credential).toMatchObject({
		...input(),
		rootKind: 1,
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
			root_id: "node-1",
			root_kind: 1,
			maximum_submission_age: "3600",
			allowed_clock_skew: "60",
		},
	]);
	const ref = { ...reference, credentialId: created.credential.id };
	const rotated = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.rotateCollectorCredential(database.db, actor, ref),
		),
	);
	expect(rotated.token).not.toBe(created.token);
	expect(rotated.credential.id).toBe(created.credential.id);
	expect(rotated.credential.rotatedAt).not.toBeNull();
	expect(await lookup(created.token)).toEqual([]);
	expect(await lookup(rotated.token)).toHaveLength(1);
	const listed = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.listCollectorCredentials(database.db, actor, reference),
		),
	);
	expect(listed).toEqual([rotated.credential]);
	expect(Object.keys(listed[0])).not.toContain("tokenSha256");
	expect(Object.keys(listed[0])).not.toContain("token");
	const revoked = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, ref),
		),
	);
	expect(revoked.revokedAt).not.toBeNull();
	expect(
		data(
			await credentials(owner.headers, (actor) =>
				credentialDomain.revokeCollectorCredential(database.db, actor, ref),
			),
		),
	).toEqual(revoked);
	expect(await lookup(rotated.token)).toEqual([]);
	expect(
		(
			await credentials(owner.headers, (actor) =>
				credentialDomain.rotateCollectorCredential(database.db, actor, ref),
			)
		).error?.code,
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
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	async function denied(headers: Headers, code: OperationErrorCode) {
		expect(
			(
				await credentials(headers, (actor) =>
					credentialDomain.listCollectorCredentials(
						database.db,
						actor,
						reference,
					),
				)
			).error?.code,
		).toBe(code);
		expect(
			(
				await credentials(headers, (actor) =>
					credentialDomain.createCollectorCredential(
						database.db,
						actor,
						input(),
					),
				)
			).error?.code,
		).toBe(code);
		expect(
			(
				await credentials(headers, (actor) =>
					credentialDomain.rotateCollectorCredential(database.db, actor, ref),
				)
			).error?.code,
		).toBe(code);
		expect(
			(
				await credentials(headers, (actor) =>
					credentialDomain.revokeCollectorCredential(database.db, actor, ref),
				)
			).error?.code,
		).toBe(code);
	}
	await denied(new Headers(), "UNAUTHENTICATED");
	await denied(collaborator.headers, "NOT_FOUND");
	for (const role of ["viewer", "member"] as const) {
		data(
			await organizations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: membership.id,
					role,
				}),
			),
		);
		await denied(collaborator.headers, "FORBIDDEN");
	}
	data(
		await organizations(owner.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: membership.id,
				role: "admin",
			}),
		),
	);
	expect(
		data(
			await credentials(collaborator.headers, (actor) =>
				credentialDomain.listCollectorCredentials(
					database.db,
					actor,
					reference,
				),
			),
		),
	).toHaveLength(1);
	data(
		await credentials(collaborator.headers, (actor) =>
			credentialDomain.rotateCollectorCredential(database.db, actor, ref),
		),
	);
	const explicitAdminCredential = data(
		await credentials(collaborator.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	data(
		await credentials(collaborator.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, {
				...reference,
				credentialId: explicitAdminCredential.credential.id,
			}),
		),
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
		await organizations(owner.headers, (actor) =>
			projectDomain.setProjectMember(database.db, actor, {
				...reference,
				memberId: membership.id,
				role: "viewer",
			}),
		),
	);
	const second = data(
		await credentials(collaborator.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				...input(),
				sourceId: "second",
			}),
		),
	);
	data(
		await credentials(collaborator.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, {
				...reference,
				credentialId: second.credential.id,
			}),
		),
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
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	const otherProject = data(
		await organizations(owner.headers, (actor) =>
			projectDomain.createProject(database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: reference.organizationId,
				name: "Other",
				slug: "other",
			}),
		),
	);
	const otherOrg = data(
		await organizations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Other",
				slug: "other-org",
			}),
		),
	);
	for (const wrong of [
		{ ...reference, projectId: otherProject.id },
		{ ...reference, organizationId: otherOrg.id },
	]) {
		const ref = { ...wrong, credentialId: created.credential.id };
		expect(
			(
				await credentials(owner.headers, (actor) =>
					credentialDomain.rotateCollectorCredential(database.db, actor, ref),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await credentials(owner.headers, (actor) =>
					credentialDomain.revokeCollectorCredential(database.db, actor, ref),
				)
			).error?.code,
		).toBe("NOT_FOUND");
	}
	expect(
		data(
			await credentials(owner.headers, (actor) =>
				credentialDomain.listCollectorCredentials(database.db, actor, {
					...reference,
					projectId: otherProject.id,
				}),
			),
		),
	).toEqual([]);
	expect(
		(
			await credentials(owner.headers, (actor) =>
				credentialDomain.createCollectorCredential(database.db, actor, {
					...input(),
					organizationId: otherOrg.id,
				}),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	const outsider = await actor();
	expect(
		(
			await credentials(outsider.headers, (actor) =>
				credentialDomain.listCollectorCredentials(
					database.db,
					actor,
					reference,
				),
			)
		).error?.code,
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
			await credentials(owner.headers, (actor) =>
				credentialDomain.createCollectorCredential(database.db, actor, {
					...input(),
					expiresAt: "2000-01-01T00:00:00Z",
				}),
			)
		).error?.code,
	).toBe("INVALID_INPUT");
	const expiresAt = new Date(Date.now() + 60_000).toISOString();
	const created = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				...input(),
				expiresAt,
			}),
		),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	const rotated = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.rotateCollectorCredential(database.db, actor, ref),
		),
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
		(
			await credentials(owner.headers, (actor) =>
				credentialDomain.rotateCollectorCredential(database.db, actor, ref),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	expect(
		data(
			await credentials(owner.headers, (actor) =>
				credentialDomain.listCollectorCredentials(
					database.db,
					actor,
					reference,
				),
			),
		)[0].expiresAt,
	).toEqual(new Date("2001-01-01T00:00:00.000Z"));
	data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, ref),
		),
	);
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
				await credentials(owner.headers, (actor) =>
					credentialDomain.createCollectorCredential(database.db, actor, {
						...input(),
						expiresAt,
					}),
				)
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
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	for (const patch of [
		{ sourceId: "" },
		{ sourceId: "é".repeat(65) },
		{ sourceId: "bad\u0085source" },
		{ rootId: "" },
		{ rootId: "bad\nnode" },
		{ rootId: "recount.local.forged" },
		{ rootKind: 9 },
		{ maximumSubmissionAge: 0 },
		{ allowedClockSkew: -1 },
		{ maximumSubmissionAge: 18446744073, allowedClockSkew: 1 },
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
	const longUpload = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				...input(),
				maximumSubmissionAge: 7 * 86400,
				allowedClockSkew: 0,
			}),
		),
	);
	expect(longUpload.credential.maximumSubmissionAge).toBe(604800);
	expect(longUpload.credential.allowedClockSkew).toBe(0);
	// Source identity is project-scoped, and multiple independently revocable installations are allowed.
	const another = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
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
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, input()),
		),
	);
	const ref = { ...reference, credentialId: created.credential.id };
	const [rotation, revocation] = await Promise.all([
		credentials(owner.headers, (actor) =>
			credentialDomain.rotateCollectorCredential(database.db, actor, ref),
		),
		credentials(owner.headers, (actor) =>
			credentialDomain.revokeCollectorCredential(database.db, actor, ref),
		),
	]);
	expect(revocation.error).toBeNull();
	if (rotation.data) expect(await lookup(rotation.data.token)).toEqual([]);
	else expect(rotation.error.code).toBe("NOT_FOUND");
	expect(await lookup(created.token)).toEqual([]);
	expect(
		(
			await credentials(owner.headers, (actor) =>
				credentialDomain.rotateCollectorCredential(database.db, actor, ref),
			)
		).error?.code,
	).toBe("NOT_FOUND");
	await database.db.delete(project).where(eq(project.id, reference.projectId));
	expect(await database.db.select().from(collectorCredential)).toEqual([]);
	expect(await database.db.select().from(collectorRootGrant)).toEqual([]);
	expect(await database.db.select().from(collectorResourceGrant)).toEqual([]);
});

test("root/local and independent grants are atomic, tenant-qualified and survive rotation", async () => {
	const created = data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(database.db, actor, {
				...input(),
				adapter: "linux",
				allowedLocalKinds: [4],
				resources: [{ resourceId: "vm", resourceKind: 5 }],
			}),
		),
	);
	const roots = await database.db.select().from(collectorRootGrant);
	const resources = await database.db.select().from(collectorResourceGrant);
	expect(roots).toHaveLength(1);
	expect(roots[0]).toMatchObject({
		credentialId: created.credential.id,
		projectId: reference.projectId,
		organizationId: reference.organizationId,
		resourceId: "node-1",
		adapter: "linux",
		allowedLocalKinds: [4],
	});
	expect(resources[0]).toMatchObject({ resourceId: "vm", resourceKind: 5 });
	data(
		await credentials(owner.headers, (actor) =>
			credentialDomain.rotateCollectorCredential(database.db, actor, {
				...reference,
				credentialId: created.credential.id,
			}),
		),
	);
	expect(await database.db.select().from(collectorRootGrant)).toEqual(roots);
	expect(await database.db.select().from(collectorResourceGrant)).toEqual(
		resources,
	);
	await expect(
		database.db
			.update(collectorRootGrant)
			.set({ organizationId: "other" })
			.execute(),
	).rejects.toMatchObject({ cause: { code: "23503" } });
	await expect(
		database.db
			.update(collectorRootGrant)
			.set({ allowedLocalKinds: [5] })
			.execute(),
	).rejects.toMatchObject({ cause: { code: "23514" } });
});
