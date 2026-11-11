import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Locale } from "@recount/i18n";
import type { OrganizationInvitationEmailProps } from "@recount/transactional";
import { eq } from "drizzle-orm";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	invitation,
	member,
	organizationOwnerGuard,
	projectMember,
	rateLimit,
	user,
} from "../../src/db/schema";
import type { OperationResult } from "../../src/lib/operation-result";
import { resolveOrganizationRole } from "../../src/organizations/access.server";
import type { OrganizationRole } from "../../src/organizations/contracts";
import { parseCreateInvitationInput } from "../../src/organizations/invitation-validation";
import * as invitationDomain from "../../src/organizations/invitations.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

const origin = "http://localhost:3001";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let authInstances: ReturnType<typeof createAuth>[];
let operations: ReturnType<typeof actorService>;
let codes: Map<string, string>;
let actorCount: number;
let invitationEmails: OrganizationInvitationEmailProps[];
let failInvitationDelivery: boolean;
let signInLocales: Locale[];

beforeEach(async () => {
	authInstances = [];
	database = await createTestDatabase("organizations");
	codes = new Map();
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
			sendSignInCode: async (email, code, locale) => {
				codes.set(email, code);
				signInLocales.push(locale);
			},
			sendOrganizationInvitation: async (props) => {
				if (failInvitationDelivery) throw new Error("Email delivery failed");
				invitationEmails.push(props);
			},
		},
	);
	authInstances.push(auth);
	operations = actorService(auth);
});

describe("native organization invitations", () => {
	test("carries the initiating locale through native invitation creation, resend and email codes", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const headers = new Headers(owner.headers);
		headers.set("cookie", `${headers.get("cookie")}; recount_locale=fr`);
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
			await operations(headers, () =>
				invitationDomain.createInvitation(
					auth,
					headers,
					input,
					initiatingRequest(),
				),
			),
		);
		const resent = data(
			await operations(headers, () =>
				invitationDomain.createInvitation(
					auth,
					headers,
					{ ...input, resend: true },
					initiatingRequest(),
				),
			),
		);
		expect(resent.id).toBe(created.id);
		expect(invitationEmails.map((email) => email.locale)).toEqual(["fr", "fr"]);
		headers.set(
			"cookie",
			`${owner.headers.get("cookie")}; recount_locale=unsupported`,
		);
		data(
			await operations(headers, () =>
				invitationDomain.createInvitation(
					auth,
					headers,
					{ ...input, resend: true },
					initiatingRequest(),
				),
			),
		);
		expect(invitationEmails.at(-1)?.locale).toBe("en");
		const response = await auth.handler(
			new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
				method: "POST",
				headers: {
					origin,
					"content-type": "application/json",
					cookie: "recount_locale=fr",
				},
				body: JSON.stringify({
					email: "french-signin@example.invalid",
					type: "sign-in",
				}),
			}),
		);
		expect(response.status).toBe(200);
		await auth.emailDelivery.drain();
		expect(signInLocales.at(-1)).toBe("fr");
	});

	test("delivers a review link and accepts into canonical membership once", async () => {
		const owner = await actor();
		const organization = await createOrganization(owner);
		const created = data(
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(
					auth,
					owner.headers,
					parseCreateInvitationInput({
						organizationId: organization.id,
						email: "  USER-2@EXAMPLE.INVALID  ",
						role: "member",
					}),
				),
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
			data(
				await operations(recipient.headers, () =>
					invitationDomain.inspectInvitation(
						auth,
						recipient.headers,
						reference,
					),
				),
			),
		).toMatchObject({
			...created,
			organizationName: organization.name,
			organizationSlug: organization.slug,
			inviterEmail: owner.email,
		});
		expect(
			data(
				await operations(recipient.headers, (actor) =>
					organizationDomain.listOrganizations(database.db, actor),
				),
			),
		).toEqual([]);
		const outcomes = await Promise.all([
			operations(recipient.headers, () =>
				invitationDomain.acceptInvitation(auth, recipient.headers, reference),
			),
			operations(recipient.headers, () =>
				invitationDomain.acceptInvitation(auth, recipient.headers, reference),
			),
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
			data(
				await operations(recipient.headers, (actor) =>
					projectDomain.listProjects(database.db, actor, organization.id),
				),
			),
		).toEqual([]);
		expect(
			(
				await operations(recipient.headers, () =>
					invitationDomain.inspectInvitation(
						auth,
						recipient.headers,
						reference,
					),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations(recipient.headers, () =>
					invitationDomain.rejectInvitation(auth, recipient.headers, reference),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations(owner.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						owner.headers,
						actor,
						{
							...reference,
							organizationId: organization.id,
						},
					),
				)
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
			(
				await operations(ordinary.headers, () =>
					invitationDomain.createInvitation(auth, ordinary.headers, input),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		expect(
			(
				await operations(outsider.headers, () =>
					invitationDomain.createInvitation(auth, outsider.headers, input),
				)
			).error,
		).not.toBeNull();
		expect(
			(
				await operations(administrator.headers, () =>
					invitationDomain.createInvitation(auth, administrator.headers, {
						...input,
						role: "owner",
					}),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		const created = data(
			await operations(administrator.headers, () =>
				invitationDomain.createInvitation(auth, administrator.headers, input),
			),
		);
		// Native Better Auth permits organization members to list invitations.
		expect(
			data(
				await operations(ordinary.headers, () =>
					invitationDomain.listInvitations(
						auth,
						ordinary.headers,
						organization.id,
					),
				),
			),
		).toEqual([created]);
		expect(
			(
				await operations(outsider.headers, () =>
					invitationDomain.listInvitations(
						auth,
						outsider.headers,
						organization.id,
					),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		const reference = {
			organizationId: organization.id,
			invitationId: created.id,
		};
		expect(
			(
				await operations(ordinary.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						ordinary.headers,
						actor,
						reference,
					),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		expect(
			(
				await operations(outsider.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						outsider.headers,
						actor,
						reference,
					),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations(owner.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						owner.headers,
						actor,
						{
							...reference,
							organizationId: other.id,
						},
					),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			data(
				await operations(administrator.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						administrator.headers,
						actor,
						reference,
					),
				),
			).status,
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
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
				await operations(administrator.headers, () =>
					invitationDomain.createInvitation(auth, administrator.headers, {
						...input,
						role: "member",
						resend: true,
					}),
				)
			).error?.code,
		).toBe("INVALID_INPUT");
		expect(
			(
				await operations(administrator.headers, () =>
					invitationDomain.createInvitation(auth, administrator.headers, {
						...input,
						resend: true,
					}),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		expect(invitationEmails).toHaveLength(1);
		const resent = data(
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, {
					...input,
					resend: true,
				}),
			),
		);
		expect(resent.id).toBe(created.id);
		expect(invitationEmails).toHaveLength(2);
		expect(await database.db.select().from(invitation)).toHaveLength(1);
		data(
			await operations(recipient.headers, () =>
				invitationDomain.acceptInvitation(auth, recipient.headers, {
					invitationId: created.id,
				}),
			),
		);
		expect(
			data(
				await operations(recipient.headers, (actor) =>
					organizationDomain.getOrganization(
						database.db,
						actor,
						organization.id,
					),
				),
			).role,
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, {
					organizationId: organization.id,
					email: recipient.email,
					role: "member",
				}),
			),
		);
		const reference = { invitationId: created.id };
		for (const operation of [
			invitationDomain.inspectInvitation,
			invitationDomain.acceptInvitation,
			invitationDomain.rejectInvitation,
		]) {
			expect(
				(
					await operations<unknown>(new Headers(), () =>
						operation(auth, new Headers(), reference),
					)
				).error?.code,
			).toBe("UNAUTHENTICATED");
			expect(
				(
					await operations<unknown>(stranger.headers, () =>
						operation(auth, stranger.headers, reference),
					)
				).error?.code,
			).toBe("FORBIDDEN");
		}
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, recipient.userId));
		for (const operation of [
			invitationDomain.inspectInvitation,
			invitationDomain.acceptInvitation,
			invitationDomain.rejectInvitation,
		]) {
			expect(
				(
					await operations<unknown>(recipient.headers, () =>
						operation(auth, recipient.headers, reference),
					)
				).error?.code,
			).toBe("FORBIDDEN");
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
			data(
				await operations(recipient.headers, () =>
					invitationDomain.rejectInvitation(auth, recipient.headers, reference),
				),
			),
		).toEqual(reference);
		expect(
			(
				await operations(recipient.headers, () =>
					invitationDomain.acceptInvitation(auth, recipient.headers, reference),
				)
			).error?.code,
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
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
			(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, input),
				)
			).error,
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, {
					organizationId: organization.id,
					email: "new@example.invalid",
					role: "member",
				}),
			),
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
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
			await operations(administrator.headers, () =>
				invitationDomain.createInvitation(auth, administrator.headers, {
					...input,
					role: "member",
				}),
			),
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
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
				invitationDomain.inspectInvitation,
				invitationDomain.acceptInvitation,
				invitationDomain.rejectInvitation,
			]) {
				expect(
					(
						await operations<unknown>(recipient.headers, () =>
							operation(auth, recipient.headers, { invitationId }),
						)
					).error?.code,
				).toBe("NOT_FOUND");
			}
		}
		const renewed = data(
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, {
					...input,
					resend: true,
				}),
			),
		);
		expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(renewed.id).not.toBe(created.id);
		data(
			await operations(owner.headers, (actor) =>
				invitationDomain.cancelInvitation(
					database.db,
					auth,
					owner.headers,
					actor,
					{
						organizationId: organization.id,
						invitationId: renewed.id,
					},
				),
			),
		);
		for (const operation of [
			invitationDomain.inspectInvitation,
			invitationDomain.acceptInvitation,
			invitationDomain.rejectInvitation,
		]) {
			expect(
				(
					await operations<unknown>(recipient.headers, () =>
						operation(auth, recipient.headers, { invitationId: renewed.id }),
					)
				).error?.code,
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
		);
		expect(invitationEmails).toHaveLength(0);
		const pending = data(
			await operations(owner.headers, () =>
				invitationDomain.listInvitations(auth, owner.headers, organization.id),
			),
		);
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("pending");
		expect(pending[0].id).toBe(created.id);
		failInvitationDelivery = false;
		expect(
			data(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, {
						...input,
						resend: true,
					}),
				),
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
		data(
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
		);
		expect(
			(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, input),
				)
			).error?.code,
		).toBe("CONFLICT");
		expect(
			(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, {
						...input,
						email: owner.email,
					}),
				)
			).error?.code,
		).toBe("CONFLICT");
		expect(
			(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, {
						...input,
						email: "not-an-email",
					}),
				)
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
		data(
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, input),
			),
		);
		for (let attempt = 1; attempt < 10; attempt++) {
			data(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, {
						...input,
						resend: true,
					}),
				),
			);
		}
		expect(
			(
				await operations(owner.headers, () =>
					invitationDomain.createInvitation(auth, owner.headers, {
						...input,
						resend: true,
					}),
				)
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
			await operations(owner.headers, () =>
				invitationDomain.createInvitation(auth, owner.headers, {
					...input,
					resend: true,
				}),
			),
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
				sendSignInCode: async () => {},
				sendOrganizationInvitation: async (props) => {
					invitationEmails.push(props);
				},
			},
		);
		authInstances.push(secondAuth);
		const second = actorService(secondAuth);
		const outcomes = await Promise.all(
			Array.from({ length: 15 }, (_, index) =>
				(index % 2 ? operations : second)(owner.headers, () =>
					invitationDomain.createInvitation(
						index % 2 ? auth : secondAuth,
						owner.headers,
						{
							organizationId: organization.id,
							email: `concurrent-${index}@example.invalid`,
							role: "member",
						},
					),
				),
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
			await operations(administrator.headers, () =>
				invitationDomain.createInvitation(auth, administrator.headers, {
					organizationId: organization.id,
					email: "new@example.invalid",
					role: "member",
				}),
			),
		);
		await auth.api.removeMember({
			headers: owner.headers,
			body: {
				organizationId: organization.id,
				memberIdOrEmail: adminMember.id,
			},
		});
		expect(
			(
				await operations(administrator.headers, () =>
					invitationDomain.listInvitations(
						auth,
						administrator.headers,
						organization.id,
					),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		expect(
			(
				await operations(administrator.headers, (actor) =>
					invitationDomain.cancelInvitation(
						database.db,
						auth,
						administrator.headers,
						actor,
						{
							organizationId: organization.id,
							invitationId: created.id,
						},
					),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		await auth.handler(post("/sign-out", {}, owner.headers));
		expect(
			(
				await operations(owner.headers, () =>
					invitationDomain.listInvitations(
						auth,
						owner.headers,
						organization.id,
					),
				)
			).error?.code,
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
	await Promise.all(
		authInstances.map((instance) => instance.emailDelivery.close()),
	);
	await database?.close();
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
	const account = await trustedActor(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	return { headers: account.headers, userId: account.id, email };
}

async function createOrganization(
	owner: Awaited<ReturnType<typeof actor>>,
	slug = "test-org",
) {
	return data(
		await operations(owner.headers, () =>
			organizationDomain.createOrganization(auth, owner.headers, {
				name: "Test organization",
				slug,
			}),
		),
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
				await operations(owner.headers, () =>
					organizationDomain.createOrganization(auth, owner.headers, {
						name: "Duplicate",
						slug: organization.slug,
					}),
				)
			).error?.code,
		).toBe("CONFLICT");
		expect(
			data(
				await operations(owner.headers, (actor) =>
					organizationDomain.listOrganizations(database.db, actor),
				),
			),
		).toEqual([organization]);
		expect(
			data(
				await operations(outsider.headers, (actor) =>
					organizationDomain.listOrganizations(database.db, actor),
				),
			),
		).toEqual([]);
		expect(
			(
				await operations(outsider.headers, (actor) =>
					organizationDomain.getOrganization(
						database.db,
						actor,
						organization.id,
					),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations(new Headers(), () =>
					organizationDomain.createOrganization(auth, new Headers(), {
						name: "Denied",
						slug: "denied",
					}),
				)
			).error?.code,
		).toBe("UNAUTHENTICATED");
		await database.db
			.update(user)
			.set({ emailVerified: false })
			.where(eq(user.id, outsider.userId));
		expect(
			(
				await operations(outsider.headers, () =>
					organizationDomain.createOrganization(auth, outsider.headers, {
						name: "Denied",
						slug: "denied",
					}),
				)
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
			await operations(owner.headers, (actor) =>
				projectDomain.createProject(database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Private project",
				}),
			),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		expect(
			data(
				await operations(collaborator.headers, (actor) =>
					projectDomain.listProjects(database.db, actor, organization.id),
				),
			),
		).toEqual([]);
		expect(
			(
				await operations(collaborator.headers, (actor) =>
					projectDomain.getProject(database.db, actor, reference),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await operations(collaborator.headers, (actor) =>
					projectDomain.createProject(database.db, actor, {
						requestId: crypto.randomUUID(),
						organizationId: organization.id,
						name: "Denied",
					}),
				)
			).error?.code,
		).toBe("FORBIDDEN");
		for (const role of ["viewer", "member"] as const) {
			data(
				await operations(owner.headers, (actor) =>
					projectDomain.setProjectMember(database.db, actor, {
						...reference,
						memberId: collaboratorMember.id,
						role,
					}),
				),
			);
			expect(
				data(
					await operations(collaborator.headers, (actor) =>
						projectDomain.getProject(database.db, actor, reference),
					),
				).role,
			).toBe(role);
			expect(
				(
					await operations(collaborator.headers, (actor) =>
						projectDomain.updateProject(database.db, actor, {
							...reference,
							name: "Denied",
						}),
					)
				).error?.code,
			).toBe("FORBIDDEN");
			expect(
				(
					await operations(collaborator.headers, (actor) =>
						projectDomain.setProjectMember(database.db, actor, {
							...reference,
							memberId: collaboratorMember.id,
							role: "admin",
						}),
					)
				).error?.code,
			).toBe("FORBIDDEN");
		}
		data(
			await operations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: collaboratorMember.id,
					role: "admin",
				}),
			),
		);
		expect(
			data(
				await operations(collaborator.headers, (actor) =>
					projectDomain.updateProject(database.db, actor, {
						...reference,
						name: "Updated",
					}),
				),
			).name,
		).toBe("Updated");
		data(
			await operations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: adminMember.id,
					role: "viewer",
				}),
			),
		);
		expect(
			data(
				await operations(administrator.headers, (actor) =>
					projectDomain.getProject(database.db, actor, reference),
				),
			).role,
		).toBe("admin");
		const second = await createOrganization(owner, "second-org");
		expect(
			data(
				await operations(owner.headers, (actor) =>
					projectDomain.createProject(database.db, actor, {
						requestId: crypto.randomUUID(),
						organizationId: second.id,
						name: "Independent",
					}),
				),
			).organizationId,
		).toBe(second.id);
		expect(
			(
				await operations(owner.headers, (actor) =>
					projectDomain.getProject(database.db, actor, {
						...reference,
						organizationId: second.id,
					}),
				)
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
			await operations(owner.headers, (actor) =>
				projectDomain.createProject(database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Project",
				}),
			),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		expect(
			(
				await operations(owner.headers, (actor) =>
					projectDomain.setProjectMember(database.db, actor, {
						...reference,
						memberId: outsideMember.id,
						role: "viewer",
					}),
				)
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
				await operations(owner.headers, (actor) =>
					projectDomain.removeProjectMember(database.db, actor, {
						...reference,
						memberId: outsideMember.id,
					}),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(
			data(
				await operations(owner.headers, (actor) =>
					projectDomain.removeProjectMember(database.db, actor, {
						...reference,
						memberId: collaboratorMember.id,
					}),
				),
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
			await operations(owner.headers, (actor) =>
				projectDomain.setProjectMember(database.db, actor, {
					...reference,
					memberId: collaboratorMember.id,
					role: "viewer",
				}),
			),
		);
		await auth.api.removeMember({
			headers: owner.headers,
			body: {
				organizationId: organization.id,
				memberIdOrEmail: collaboratorMember.id,
			},
		});
		expect(
			(
				await operations(collaborator.headers, (actor) =>
					projectDomain.getProject(database.db, actor, reference),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		expect(await database.db.select().from(projectMember)).toHaveLength(0);
		await addMember(organization.id, collaborator);
		expect(
			(
				await operations(collaborator.headers, (actor) =>
					projectDomain.getProject(database.db, actor, reference),
				)
			).error?.code,
		).toBe("NOT_FOUND");
		await auth.handler(post("/sign-out", {}, collaborator.headers));
		expect(
			(
				await operations(collaborator.headers, (actor) =>
					projectDomain.getProject(database.db, actor, reference),
				)
			).error?.code,
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
			data(
				await operations(invited.headers, (actor) =>
					organizationDomain.getOrganization(
						database.db,
						actor,
						organization.id,
					),
				),
			).role,
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
			data(
				await operations(second.headers, (actor) =>
					organizationDomain.getOrganization(
						database.db,
						actor,
						organization.id,
					),
				),
			).role,
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
