import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OrganizationInvitationEmailProps } from "@recount/transactional";
import { eq } from "drizzle-orm";
import { createAuth } from "../../src/auth/create-auth.server";
import { invitation, rateLimit } from "../../src/db/schema";
import type { CreateInvitationsInput } from "../../src/organizations/invitation-contracts";
import { createInvitations } from "../../src/organizations/invitations.server";
import { createOrganization } from "../../src/organizations/organizations.server";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const origin = "http://localhost:3961";
const codes = new Map<string, string>();
const emails: OrganizationInvitationEmailProps[] = [];
beforeAll(async () => {
	database = await createTestDatabase("invitebatch");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `invitation-batch-${randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async (props) => {
				emails.push(props);
			},
		},
	);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});
async function fixture() {
	const owner = await trustedActor(
		auth,
		`${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	const organization = await createOrganization(auth, owner.headers, {
		name: "Batch organization",
		slug: randomUUID(),
	});
	const input: CreateInvitationsInput = {
		organizationId: organization.id,
		message: "Welcome aboard",
		recipients: ["first", "second", "third"].map((clientId) => ({
			clientId,
			email: `${clientId}-${randomUUID()}@example.invalid`,
			role: "member",
			recipientName: clientId,
		})),
	};
	return { owner, organization, input };
}

test("one batch preserves recipient roles, personalization, locale and per-recipient quota", async () => {
	const { owner, input } = await fixture();
	input.recipients[1].role = "admin";
	const headers = new Headers(owner.headers);
	headers.set("cookie", `${headers.get("cookie")}; recount_locale=fr`);
	const request = new Request(`${origin}/_serverFn/invitation-batch`, {
		method: "POST",
		headers,
	});
	const result = await createInvitations(
		database.db,
		auth,
		headers,
		owner,
		input,
		request,
	);
	expect(result.results.map((row) => [row.clientId, row.status])).toEqual([
		["first", "created"],
		["second", "created"],
		["third", "created"],
	]);
	const stored = await database.db
		.select()
		.from(invitation)
		.where(eq(invitation.organizationId, input.organizationId));
	expect(stored).toHaveLength(3);
	expect(
		stored.find((row) => row.email === input.recipients[1].email)?.role,
	).toBe("admin");
	await auth.emailDelivery.drain();
	for (const recipient of input.recipients)
		expect(
			emails.find((email) => email.email === recipient.email),
		).toMatchObject({
			locale: "fr",
			message: "Welcome aboard",
			recipientName: recipient.recipientName,
			role: recipient.role,
		});
	const [limit] = await database.db
		.select()
		.from(rateLimit)
		.where(eq(rateLimit.key, `invitation-send:${owner.id}`));
	expect(limit.count).toBe(3);
});

test("known recipient failures do not hide successful or subsequent results", async () => {
	const { owner, input } = await fixture();
	await auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: input.organizationId,
			email: input.recipients[1].email,
			role: "member",
		},
	});
	const result = await createInvitations(
		database.db,
		auth,
		owner.headers,
		owner,
		input,
	);
	expect(result.results.map((row) => row.status)).toEqual([
		"created",
		"rejected",
		"created",
	]);
	expect(result.results[1]).toMatchObject({
		clientId: "second",
		error: { code: "CONFLICT" },
	});
	expect(
		await database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, input.organizationId)),
	).toHaveLength(3);
});

test("an invalid later email rejects the entire batch before invitation or quota writes", async () => {
	const { owner, input } = await fixture();
	input.recipients[1].email = "two..dots@example.invalid";
	await expect(
		createInvitations(database.db, auth, owner.headers, owner, input),
	).rejects.toThrow("valid email address");
	expect(
		await database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, input.organizationId)),
	).toHaveLength(0);
	expect(
		await database.db
			.select()
			.from(rateLimit)
			.where(eq(rateLimit.key, `invitation-send:${owner.id}`)),
	).toHaveLength(0);
});

test("batch authorization and owner-role preflight prevent partial unauthorized writes", async () => {
	const { owner, input } = await fixture();
	const other = await trustedActor(
		auth,
		`${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	await expect(
		createInvitations(database.db, auth, other.headers, other, input),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await auth.api.addMember({
		body: {
			organizationId: input.organizationId,
			userId: other.id,
			role: "member",
		},
	});
	await expect(
		createInvitations(database.db, auth, other.headers, other, input),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const membership = await auth.api.listMembers({
		headers: owner.headers,
		query: { organizationId: input.organizationId },
	});
	const member = membership.members.find(
		(member) => member.userId === other.id,
	);
	if (!member) throw new Error("Expected fixture membership");
	await auth.api.updateMemberRole({
		headers: owner.headers,
		body: {
			organizationId: input.organizationId,
			memberId: member.id,
			role: "admin",
		},
	});
	input.recipients[2].role = "owner";
	await expect(
		createInvitations(database.db, auth, other.headers, other, input),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(
		await database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, input.organizationId)),
	).toHaveLength(0);
});

test("batch size does not bypass native invitation throttling and unattempted rows are explicit", async () => {
	const { owner, input } = await fixture();
	await database.db.insert(rateLimit).values({
		id: randomUUID(),
		key: `invitation-send:${owner.id}`,
		count: 9,
		lastRequest: Date.now(),
	});
	const result = await createInvitations(
		database.db,
		auth,
		owner.headers,
		owner,
		input,
	);
	expect(result.results.map((row) => row.status)).toEqual([
		"created",
		"rejected",
		"not-attempted",
	]);
	expect(result.results[1]).toMatchObject({ error: { code: "RATE_LIMITED" } });
	expect(
		await database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, input.organizationId)),
	).toHaveLength(1);
});
