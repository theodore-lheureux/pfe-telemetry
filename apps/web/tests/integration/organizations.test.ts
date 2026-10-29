import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { Locale } from "@pfe/i18n";
import type { OrganizationInvitationEmailProps } from "@pfe/transactional";
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
	rateLimit,
	user,
} from "../../src/db/schema";
import { resolveOrganizationRole } from "../../src/organizations/access.server";
import type {
	OperationResult,
	OrganizationRole,
} from "../../src/organizations/contracts";
import { parseCreateInvitationInput } from "../../src/organizations/invitation-validation";
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
let invitationEmails: OrganizationInvitationEmailProps[];
let failInvitationDelivery: boolean;
let signInLocales: Locale[];

beforeEach(async () => {
	databaseName = `pfe_org_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 4 });
	links = new Map();
	actorCount = 0;
	invitationEmails = [];
	failInvitationDelivery = false;
	signInLocales = [];
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `test-only-organization-secret-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInLink: async (email, url, locale) => {
				links.set(email, url);
				signInLocales.push(locale);
			},
			sendOrganizationInvitation: async (props) => {
				if (failInvitationDelivery) throw new Error("Email delivery failed");
				invitationEmails.push(props);
			},
		},
	);
	operations = createOrganizationRequests(database.db, auth);
});

describe("native organization invitations", () => {
	test("carries the initiating locale through native invitation creation, resend and magic links", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const headers = new Headers(owner.headers);
		headers.set("cookie", `${headers.get("cookie")}; pfe_locale=fr`);
		const initiatingRequest = () =>
			new Request(`${origin}/_serverFn/test-invitation`, {
				method: "POST",
				headers,
			});
		const input = {
			organizationId: organization.id,
			email: "french-recipient@example.invalid",
			role: "member" as const,
		};
		const created = data(
			await operations.createInvitation(headers, input, initiatingRequest()),
		);
		const resent = data(
			await operations.createInvitation(
				headers,
				{ ...input, resend: true },
				initiatingRequest(),
			),
		);
		expect(resent.id).toBe(created.id);
		expect(invitationEmails.map((email) => email.locale)).toEqual(["fr", "fr"]);
		headers.set(
			"cookie",
			`${owner.headers.get("cookie")}; pfe_locale=unsupported`,
		);
		data(
			await operations.createInvitation(
				headers,
				{ ...input, resend: true },
				initiatingRequest(),
			),
		);
		expect(invitationEmails.at(-1)?.locale).toBe("en");
		const response = await auth.handler(
			new Request(`${origin}/api/auth/sign-in/magic-link`, {
				method: "POST",
				headers: {
					origin,
					"content-type": "application/json",
					cookie: "pfe_locale=fr",
				},
				body: JSON.stringify({
					email: "french-signin@example.invalid",
					callbackURL: "/account",
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(signInLocales.at(-1)).toBe("fr");
	});

	test("delivers a review link and accepts into canonical membership once", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const created = data(
			await operations.createInvitation(
				owner.headers,
				parseCreateInvitationInput({
					organizationId: organization.id,
					email: "  USER-2@EXAMPLE.INVALID  ",
					role: "member",
				}),
			),
		);
		expect(invitationEmails).toEqual([
			{
				url: `${origin}/invitations/${created.id}`,
				email: "user-2@example.invalid",
				organizationName: organization.name,
				inviterEmail: owner.email,
				role: "member",
				locale: "en",
				expiresAt: created.expiresAt,
			},
		]);
		const recipient = await actor();
		const reference = { invitationId: created.id };
		expect(
			data(await operations.inspectInvitation(recipient.headers, reference)),
		).toMatchObject({
			...created,
			organizationName: organization.name,
			organizationSlug: organization.slug,
			inviterEmail: owner.email,
		});
		expect(data(await operations.listOrganizations(recipient.headers))).toEqual(
			[],
		);
		const outcomes = await Promise.all([
			operations.acceptInvitation(recipient.headers, reference),
			operations.acceptInvitation(recipient.headers, reference),
		]);
		expect(outcomes.filter((outcome) => outcome.data)).toHaveLength(1);
		const accepted = outcomes.find((outcome) => outcome.data)?.data;
		expect(accepted).toMatchObject({ organizationId: organization.id });
		const memberships = await database.db
			.select()
			.from(member)
			.where(eq(member.userId, recipient.userId));
		expect(memberships).toHaveLength(1);
		expect(memberships[0]).toMatchObject({
			id: accepted?.memberId,
			organizationId: organization.id,
			role: "member",
		});
		expect(
			(await auth.api.getSession({ headers: recipient.headers }))?.session
				.activeOrganizationId,
		).toBe(organization.id);
		expect(
			data(await operations.listProjects(recipient.headers, organization.id)),
		).toEqual([]);
		expect(
			(await operations.inspectInvitation(recipient.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			(await operations.rejectInvitation(recipient.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations.cancelInvitation(owner.headers, {
					...reference,
					organizationId: organization.id,
				})
			).error?.code,
		).toBe("CONFLICT");
	});

	test("uses native organization roles and tenant boundaries for management", async () => {
		const owner = await actor();
		const administrator = await actor();
		const ordinary = await actor();
		const outsider = await actor();
		const organization = await createOrganization(owner);
		const other = await createOrganization(owner, "another-org");
		await addMember(organization.id, administrator, "admin");
		await addMember(organization.id, ordinary);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "admin" as const,
		};
		expect(
			(await operations.createInvitation(ordinary.headers, input)).error?.code,
		).toBe("FORBIDDEN");
		expect(
			(await operations.createInvitation(outsider.headers, input)).error,
		).not.toBeNull();
		expect(
			(
				await operations.createInvitation(administrator.headers, {
					...input,
					role: "owner",
				})
			).error?.code,
		).toBe("FORBIDDEN");
		const created = data(
			await operations.createInvitation(administrator.headers, input),
		);
		// Native Better Auth permits organization members to list invitations.
		expect(
			data(await operations.listInvitations(ordinary.headers, organization.id)),
		).toEqual([created]);
		expect(
			(await operations.listInvitations(outsider.headers, organization.id))
				.error?.code,
		).toBe("FORBIDDEN");
		const reference = {
			organizationId: organization.id,
			invitationId: created.id,
		};
		expect(
			(await operations.cancelInvitation(ordinary.headers, reference)).error
				?.code,
		).toBe("FORBIDDEN");
		expect(
			(await operations.cancelInvitation(outsider.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations.cancelInvitation(owner.headers, {
					...reference,
					organizationId: other.id,
				})
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			data(await operations.cancelInvitation(administrator.headers, reference))
				.status,
		).toBe("canceled");
	});

	test("protects raw native invitation endpoints and resend role restrictions", async () => {
		const owner = await actor();
		const administrator = await actor();
		const recipient = await actor();
		const organization = await createOrganization(owner);
		await addMember(organization.id, administrator, "admin");
		const input = {
			organizationId: organization.id,
			email: recipient.email,
			role: "owner" as const,
		};
		const created = data(
			await operations.createInvitation(owner.headers, input),
		);
		for (const role of ["admin,owner", ["admin", "owner"], "unknown"]) {
			expect(
				(
					await auth.handler(
						post(
							"/organization/invite-member",
							{ ...input, role, resend: true },
							administrator.headers,
						),
					)
				).status,
			).toBe(400);
		}
		expect(
			(
				await auth.handler(
					post(
						"/organization/invite-member",
						{ ...input, role: "member", resend: true },
						administrator.headers,
					),
				)
			).status,
		).toBe(400);
		expect(
			(
				await auth.handler(
					post(
						"/organization/invite-member",
						{ ...input, resend: true },
						administrator.headers,
					),
				)
			).status,
		).toBe(403);
		expect(
			(
				await operations.createInvitation(administrator.headers, {
					...input,
					role: "member",
					resend: true,
				})
			).error?.code,
		).toBe("INVALID_INPUT");
		expect(
			(
				await operations.createInvitation(administrator.headers, {
					...input,
					resend: true,
				})
			).error?.code,
		).toBe("FORBIDDEN");
		expect(invitationEmails).toHaveLength(1);
		const resent = data(
			await operations.createInvitation(owner.headers, {
				...input,
				resend: true,
			}),
		);
		expect(resent.id).toBe(created.id);
		expect(invitationEmails).toHaveLength(2);
		expect(await database.db.select().from(invitation)).toHaveLength(1);
		data(
			await operations.acceptInvitation(recipient.headers, {
				invitationId: created.id,
			}),
		);
		expect(
			data(await operations.getOrganization(recipient.headers, organization.id))
				.role,
		).toBe("owner");
		expect(
			(await database.db.select().from(organizationOwnerGuard))[0].ownerCount,
		).toBe(2);
	});

	test("requires the matching verified mailbox for inspection, acceptance and rejection", async () => {
		const owner = await actor();
		const recipient = await actor();
		const stranger = await actor();
		const organization = await createOrganization(owner);
		const created = data(
			await operations.createInvitation(owner.headers, {
				organizationId: organization.id,
				email: recipient.email,
				role: "member",
			}),
		);
		const reference = { invitationId: created.id };
		for (const operation of [
			operations.inspectInvitation,
			operations.acceptInvitation,
			operations.rejectInvitation,
		]) {
			expect((await operation(new Headers(), reference)).error?.code).toBe(
				"UNAUTHENTICATED",
			);
			expect((await operation(stranger.headers, reference)).error?.code).toBe(
				"FORBIDDEN",
			);
		}
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, recipient.userId));
		for (const operation of [
			operations.inspectInvitation,
			operations.acceptInvitation,
			operations.rejectInvitation,
		]) {
			expect((await operation(recipient.headers, reference)).error?.code).toBe(
				"FORBIDDEN",
			);
		}
		for (const path of [
			"/organization/accept-invitation",
			"/organization/reject-invitation",
		]) {
			expect(
				(await auth.handler(post(path, reference, recipient.headers))).status,
			).toBe(403);
		}
		const get = new Request(
			`${origin}/api/auth/organization/get-invitation?id=${created.id}`,
			{ headers: recipient.headers },
		);
		expect((await auth.handler(get)).status).toBe(403);
		await database.db
			.update(user)
			.set({ emailVerified: true })
			.where(eq(user.id, recipient.userId));
		expect(
			data(await operations.rejectInvitation(recipient.headers, reference)),
		).toEqual(reference);
		expect(
			(await operations.acceptInvitation(recipient.headers, reference)).error
				?.code,
		).toBe("NOT_FOUND");
		expect(
			await database.db
				.select()
				.from(member)
				.where(eq(member.userId, recipient.userId)),
		).toHaveLength(0);
	});

	test("requires verified managers even through the raw native endpoints", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "member" as const,
		};
		const created = data(
			await operations.createInvitation(owner.headers, input),
		);
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, owner.userId));
		for (const body of [input, { ...input, resend: true }]) {
			const response = await auth.handler(
				post("/organization/invite-member", body, owner.headers),
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "VERIFIED_EMAIL_REQUIRED",
			});
		}
		await expect(
			auth.api.createInvitation({ headers: owner.headers, body: input }),
		).rejects.toMatchObject({
			statusCode: 403,
			body: { code: "VERIFIED_EMAIL_REQUIRED" },
		});
		expect(
			(await operations.createInvitation(owner.headers, input)).error,
		).toMatchObject({ code: "FORBIDDEN", reason: "VERIFIED_EMAIL_REQUIRED" });
		expect(
			(
				await auth.handler(
					post(
						"/organization/cancel-invitation",
						{ invitationId: created.id },
						owner.headers,
					),
				)
			).status,
		).toBe(403);
		expect(
			(
				await auth.handler(
					new Request(
						`${origin}/api/auth/organization/list-invitations?organizationId=${organization.id}`,
						{ headers: owner.headers },
					),
				)
			).status,
		).toBe(403);
		expect(invitationEmails).toHaveLength(1);
	});

	test("protects full-organization invitation reads by ID and slug", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		data(
			await operations.createInvitation(owner.headers, {
				organizationId: organization.id,
				email: "new@example.invalid",
				role: "member",
			}),
		);
		for (const query of [
			`organizationId=${organization.id}`,
			`organizationSlug=${organization.slug}`,
		]) {
			const request = () =>
				new Request(
					`${origin}/api/auth/organization/get-full-organization?${query}`,
					{ headers: owner.headers },
				);
			expect((await auth.handler(request())).status).toBe(200);
			await database.db
				.update(user)
				.set({ emailVerified: false })
				.where(eq(user.id, owner.userId));
			expect((await auth.handler(request())).status).toBe(403);
			await database.db
				.update(user)
				.set({ emailVerified: true })
				.where(eq(user.id, owner.userId));
		}
	});

	test("resend respects native active-organization fallback and live invitation eligibility", async () => {
		const owner = await actor();
		const administrator = await actor();
		const outsider = await actor();
		const organization = await createOrganization(owner);
		await addMember(organization.id, administrator, "admin");
		await auth.api.setActiveOrganization({
			headers: administrator.headers,
			body: { organizationId: organization.id },
		});
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "owner" as const,
		};
		const created = data(
			await operations.createInvitation(owner.headers, input),
		);
		const bypass = await auth.handler(
			post(
				"/organization/invite-member",
				{ ...input, organizationId: "", role: "member", resend: true },
				administrator.headers,
			),
		);
		expect(bypass.status).toBe(400);
		expect((await bypass.json()).message).toContain("Resend must keep");
		for (const role of ["member", "owner"]) {
			const denied = await auth.handler(
				post(
					"/organization/invite-member",
					{ ...input, role, resend: true },
					outsider.headers,
				),
			);
			expect(denied.status).toBe(400);
			expect((await denied.json()).code).toBe("MEMBER_NOT_FOUND");
		}
		expect(invitationEmails).toHaveLength(1);
		await database.db
			.update(invitation)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(invitation.id, created.id));
		const replacement = data(
			await operations.createInvitation(administrator.headers, {
				...input,
				role: "member",
			}),
		);
		expect(replacement.id).not.toBe(created.id);
		const resent = await auth.handler(
			post(
				"/organization/invite-member",
				{ ...input, role: "member", resend: true },
				administrator.headers,
			),
		);
		expect(resent.status).toBe(200);
		expect((await resent.json()).id).toBe(replacement.id);
		expect(invitationEmails).toHaveLength(3);
	});

	test("rejects unknown, expired and canceled links without creating membership", async () => {
		const owner = await actor();
		const recipient = await actor();
		const organization = await createOrganization(owner);
		const input = {
			organizationId: organization.id,
			email: recipient.email,
			role: "member" as const,
		};
		const created = data(
			await operations.createInvitation(owner.headers, input),
		);
		await database.db
			.update(invitation)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(invitation.id, created.id));
		expect(
			(
				await auth.handler(
					post(
						"/organization/reject-invitation",
						{ invitationId: created.id },
						recipient.headers,
					),
				)
			).status,
		).toBe(400);
		for (const invitationId of ["missing-invitation", created.id]) {
			for (const operation of [
				operations.inspectInvitation,
				operations.acceptInvitation,
				operations.rejectInvitation,
			]) {
				expect(
					(await operation(recipient.headers, { invitationId })).error?.code,
				).toBe("NOT_FOUND");
			}
		}
		const renewed = data(
			await operations.createInvitation(owner.headers, {
				...input,
				resend: true,
			}),
		);
		expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(renewed.id).not.toBe(created.id);
		data(
			await operations.cancelInvitation(owner.headers, {
				organizationId: organization.id,
				invitationId: renewed.id,
			}),
		);
		for (const operation of [
			operations.inspectInvitation,
			operations.acceptInvitation,
			operations.rejectInvitation,
		]) {
			expect(
				(await operation(recipient.headers, { invitationId: renewed.id })).error
					?.code,
			).toBe("NOT_FOUND");
		}
		expect(
			await database.db
				.select()
				.from(member)
				.where(eq(member.userId, recipient.userId)),
		).toHaveLength(0);
	});

	test("retains native pending invitations on delivery failure and supports resend", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "member" as const,
		};
		failInvitationDelivery = true;
		const created = data(
			await operations.createInvitation(owner.headers, input),
		);
		expect(invitationEmails).toHaveLength(0);
		const pending = data(
			await operations.listInvitations(owner.headers, organization.id),
		);
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("pending");
		expect(pending[0].id).toBe(created.id);
		failInvitationDelivery = false;
		expect(
			data(
				await operations.createInvitation(owner.headers, {
					...input,
					resend: true,
				}),
			).id,
		).toBe(pending[0].id);
		expect(invitationEmails).toHaveLength(1);
	});

	test("maps duplicates and invalid email without sending additional mail", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "member" as const,
		};
		data(await operations.createInvitation(owner.headers, input));
		expect(
			(await operations.createInvitation(owner.headers, input)).error?.code,
		).toBe("CONFLICT");
		expect(
			(
				await operations.createInvitation(owner.headers, {
					...input,
					email: owner.email,
				})
			).error?.code,
		).toBe("CONFLICT");
		expect(
			(
				await operations.createInvitation(owner.headers, {
					...input,
					email: "not-an-email",
				})
			).error?.code,
		).toBe("INVALID_INPUT");
		expect(invitationEmails).toHaveLength(1);
	});

	test("limits send attempts across server API and native HTTP and recovers next window", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "member" as const,
		};
		data(await operations.createInvitation(owner.headers, input));
		for (let attempt = 1; attempt < 10; attempt++) {
			data(
				await operations.createInvitation(owner.headers, {
					...input,
					resend: true,
				}),
			);
		}
		expect(
			(
				await operations.createInvitation(owner.headers, {
					...input,
					resend: true,
				})
			).error?.code,
		).toBe("RATE_LIMITED");
		expect(
			(
				await auth.handler(
					post(
						"/organization/invite-member",
						{ ...input, resend: true },
						owner.headers,
					),
				)
			).status,
		).toBe(429);
		expect(invitationEmails).toHaveLength(10);
		await database.db
			.update(rateLimit)
			.set({ lastRequest: Date.now() - 60_001 })
			.where(eq(rateLimit.key, `invitation-send:${owner.userId}`));
		data(
			await operations.createInvitation(owner.headers, {
				...input,
				resend: true,
			}),
		);
		expect(invitationEmails).toHaveLength(11);
	});

	test("serializes concurrent send attempts across independent auth instances", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const secondAuth = createAuth(
			{
				origin,
				rpID: "localhost",
				secret: auth.options.secret as string,
				allowSignUp: true,
			},
			database.db,
			{
				sendSignInLink: async () => {
					throw new Error("Unexpected sign-in email");
				},
				sendOrganizationInvitation: async (props) => {
					invitationEmails.push(props);
				},
			},
		);
		const second = createOrganizationRequests(database.db, secondAuth);
		const outcomes = await Promise.all(
			Array.from({ length: 15 }, (_, index) =>
				(index % 2 ? operations : second).createInvitation(owner.headers, {
					organizationId: organization.id,
					email: `concurrent-${index}@example.invalid`,
					role: "member",
				}),
			),
		);
		expect(outcomes.filter((outcome) => outcome.data)).toHaveLength(10);
		expect(
			outcomes.filter((outcome) => outcome.error?.code === "RATE_LIMITED"),
		).toHaveLength(5);
		expect(invitationEmails).toHaveLength(10);
		expect(
			await database.db
				.select({ count: rateLimit.count })
				.from(rateLimit)
				.where(eq(rateLimit.key, `invitation-send:${owner.userId}`)),
		).toEqual([{ count: 15 }]);
	});

	test("revokes invitation management immediately with native membership or session revocation", async () => {
		const owner = await actor();
		const administrator = await actor();
		const organization = await createOrganization(owner);
		const adminMember = await addMember(
			organization.id,
			administrator,
			"admin",
		);
		const created = data(
			await operations.createInvitation(administrator.headers, {
				organizationId: organization.id,
				email: "new@example.invalid",
				role: "member",
			}),
		);
		await auth.api.removeMember({
			headers: owner.headers,
			body: {
				organizationId: organization.id,
				memberIdOrEmail: adminMember.id,
			},
		});
		expect(
			(await operations.listInvitations(administrator.headers, organization.id))
				.error?.code,
		).toBe("FORBIDDEN");
		expect(
			(
				await operations.cancelInvitation(administrator.headers, {
					organizationId: organization.id,
					invitationId: created.id,
				})
			).error?.code,
		).toBe("NOT_FOUND");
		await auth.handler(post("/sign-out", {}, owner.headers));
		expect(
			(await operations.listInvitations(owner.headers, organization.id)).error
				?.code,
		).toBe("UNAUTHENTICATED");
	});

	test("enforces canonical create, list and cancel permissions over actual native HTTP", async () => {
		const owner = await actor();
		const administrator = await actor();
		const ordinary = await actor();
		const outsider = await actor();
		const organization = await createOrganization(owner);
		await createOrganization(outsider, "outside-org");
		await addMember(organization.id, administrator, "admin");
		await addMember(organization.id, ordinary);
		const input = {
			organizationId: organization.id,
			email: "new@example.invalid",
			role: "member",
		};
		expect(
			(
				await auth.handler(
					post("/organization/invite-member", input, ordinary.headers),
				)
			).status,
		).toBe(403);
		expect(
			(
				await auth.handler(
					post("/organization/invite-member", input, outsider.headers),
				)
			).status,
		).toBe(400);
		expect(
			(
				await auth.handler(
					post(
						"/organization/invite-member",
						{ ...input, role: "owner" },
						administrator.headers,
					),
				)
			).status,
		).toBe(403);
		const response = await auth.handler(
			post("/organization/invite-member", input, administrator.headers),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string };
		for (const person of [owner, administrator, ordinary]) {
			const listed = await auth.handler(
				new Request(
					`${origin}/api/auth/organization/list-invitations?organizationId=${organization.id}`,
					{ headers: person.headers },
				),
			);
			expect(listed.status).toBe(200);
			expect(await listed.json()).toMatchObject([{ id: created.id }]);
		}
		expect(
			(
				await auth.handler(
					new Request(
						`${origin}/api/auth/organization/list-invitations?organizationId=${organization.id}`,
						{ headers: outsider.headers },
					),
				)
			).status,
		).toBe(403);
		for (const [person, status] of [
			[ordinary, 403],
			[outsider, 400],
		] as const) {
			expect(
				(
					await auth.handler(
						post(
							"/organization/cancel-invitation",
							{ invitationId: created.id },
							person.headers,
						),
					)
				).status,
			).toBe(status);
		}
		expect(
			(
				await auth.handler(
					post(
						"/organization/cancel-invitation",
						{ invitationId: created.id },
						administrator.headers,
					),
				)
			).status,
		).toBe(200);
		expect(
			(
				await auth.handler(
					post(
						"/organization/cancel-invitation",
						{ invitationId: created.id },
						owner.headers,
					),
				)
			).status,
		).toBe(409);
		expect(invitationEmails).toHaveLength(1);
	});
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
