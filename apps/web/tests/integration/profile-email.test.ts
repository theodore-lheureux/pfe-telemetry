import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ProfileEmailProps } from "@recount/transactional";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { accountContextHeader } from "../../src/auth/account-context";
import { createAuth } from "../../src/auth/create-auth.server";
import { session } from "../../src/db/schema";
import {
	sessionHeaders,
	trustedActor,
	trustedCodeSignIn,
} from "../auth-actors";
import { createTestDatabase } from "../database";
import { authenticatorCode } from "../totp";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const origin = "http://localhost:36685";
const secret = `profile-email-test-only-${randomUUID()}`;
const codes = new Map<string, string>();
const messages: ProfileEmailProps[] = [];
beforeAll(async () => {
	database = await createTestDatabase("profile_email");
	auth = createAuth(
		{ origin, rpID: "localhost", secret, allowSignUp: true },
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
			sendProfileEmail: async (props) => {
				messages.push(props);
			},
		},
	);
}, 60_000);
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
}, 60_000);

function actor(address = `${randomUUID()}@example.invalid`) {
	return trustedActor(auth, address, (email) => codes.get(email));
}
type Actor = Awaited<ReturnType<typeof actor>>;
let ip = 0;
function headers(current: Actor, expectedId = current.id) {
	const result = new Headers(current.headers);
	result.set("origin", origin);
	result.set("content-type", "application/json");
	result.set(accountContextHeader, expectedId);
	result.set("x-forwarded-for", `198.18.0.${++ip}`);
	result.set("cookie", `${result.get("cookie")}; recount_locale=fr`);
	return result;
}
function request(current: Actor, newEmail: string, expectedId = current.id) {
	return auth.handler(
		new Request(`${origin}/api/auth/change-email`, {
			method: "POST",
			headers: headers(current, expectedId),
			body: JSON.stringify({ newEmail }),
		}),
	);
}
function confirm(current: Actor, token: string, expectedId = current.id) {
	return auth.handler(
		new Request(
			`${origin}/api/auth/verify-email?${new URLSearchParams({ token })}`,
			{ headers: headers(current, expectedId) },
		),
	);
}
async function link(current: Actor, newEmail: string) {
	expect((await request(current, newEmail)).status).toBe(200);
	await auth.emailDelivery.drain();
	const message = messages
		.filter(
			(entry) => entry.kind === "verification" && entry.email === newEmail,
		)
		.at(-1);
	if (!message) throw new Error("Expected verification link");
	const url = new URL(message.url);
	expect(url.pathname).toBe("/email-change");
	expect(url.searchParams.get("accountId")).toBe(current.id);
	return url.searchParams.get("token") ?? "";
}
function identity(current: Actor) {
	return auth.api.getSession({ headers: current.headers });
}

test("verified link changes the same identity, revokes other sessions and notifies the previous address in French", async () => {
	const current = await actor();
	const other = await actor(current.email);
	const target = `${randomUUID()}@example.invalid`;
	const token = await link(current, target);
	expect((await identity(current))?.user.email).toBe(current.email);
	expect(messages.at(-1)?.locale).toBe("fr");
	const response = await confirm(current, token);
	expect(response.status).toBe(200);
	expect(response.headers.getSetCookie()).toHaveLength(0);
	await auth.emailDelivery.drain();
	expect((await identity(current))?.user).toMatchObject({
		id: current.id,
		email: target,
		emailVerified: true,
	});
	expect(await identity(other)).toBeNull();
	expect(messages.at(-1)).toMatchObject({
		kind: "changed",
		email: current.email,
		newEmail: target,
		locale: "fr",
	});
});

test("both requesting and accepting a link reject stale sessions", async () => {
	const current = await actor();
	const target = `${randomUUID()}@example.invalid`;
	const token = await link(current, target);
	const anonymous = { ...current, headers: new Headers() };
	expect((await request(anonymous, target)).status).toBe(401);
	expect((await confirm(anonymous, token)).status).toBe(401);
	await database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700_000) })
		.where(eq(session.userId, current.id));
	for (const response of [
		await request(current, target),
		await confirm(current, token),
	]) {
		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toHaveLength(0);
		expect(await response.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
	}
	expect((await identity(current))?.user.email).toBe(current.email);
	const revoked = await actor();
	await auth.api.signOut({ headers: revoked.headers });
	for (const response of [
		await request(revoked, target),
		await confirm(revoked, token),
	]) {
		expect(response.status).toBe(401);
		expect(response.headers.getSetCookie()).toHaveLength(0);
	}
});

test("invalid and expired links cannot change the identity", async () => {
	const current = await actor();
	const target = `${randomUUID()}@example.invalid`;
	const expired = await createEmailVerificationToken(
		secret,
		current.email,
		target,
		-1,
		{ requestType: "change-email-verification" },
	);
	for (const [token, code] of [
		["invalid", "INVALID_TOKEN"],
		[expired, "TOKEN_EXPIRED"],
	]) {
		const response = await confirm(current, token);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code });
	}
	expect((await identity(current))?.user.email).toBe(current.email);
});

test("existing accounts are neither notified nor overwritten, including a collision after link issuance", async () => {
	const current = await actor();
	const existing = await actor();
	const sent = messages.length;
	expect((await request(current, existing.email)).status).toBe(200);
	await auth.emailDelivery.drain();
	expect(messages).toHaveLength(sent);
	const target = `${randomUUID()}@example.invalid`;
	const token = await link(current, target);
	const claimed = await actor(target);
	expect((await confirm(current, token)).ok).toBe(false);
	expect((await identity(current))?.user.email).toBe(current.email);
	expect((await identity(existing))?.user.id).toBe(existing.id);
	expect((await identity(claimed))?.user.id).toBe(claimed.id);
});

test("account mismatches are rejected on request and acceptance, including a switched account opening a link", async () => {
	const current = await actor();
	const other = await actor();
	const target = `${randomUUID()}@example.invalid`;
	const token = await link(current, target);
	for (const response of [
		await request(current, target, other.id),
		await confirm(other, token, current.id),
		await confirm(current, token, ""),
	]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "ACCOUNT_CHANGED" });
	}
	// Changing the expected-account header cannot override the signed link's owner.
	expect((await confirm(other, token)).ok).toBe(false);
	expect((await identity(current))?.user.email).toBe(current.email);
	expect((await identity(other))?.user.email).toBe(other.email);
	expect((await confirm(current, token)).status).toBe(200);
});

test("a change cancels native pending two-factor sign-ins without changing enrolled credentials", async () => {
	const current = await actor();
	current.headers = headers(current);
	const enabled = await auth.api.enableTwoFactor({
		headers: current.headers,
		body: { method: "totp" },
	});
	if (!("totpURI" in enabled)) throw new Error("Expected TOTP setup");
	const enrollment = await auth.api.verifyTOTP({
		headers: current.headers,
		body: { code: authenticatorCode(enabled.totpURI) },
		asResponse: true,
	});
	current.headers = sessionHeaders(enrollment, current.headers);
	const pending = sessionHeaders(
		await trustedCodeSignIn(
			auth,
			current.email,
			(email) => codes.get(email),
			new Headers({ origin }),
		),
	);
	expect(await auth.api.twoFactorStatus({ headers: pending })).toEqual({
		pending: true,
	});
	const token = await link(current, `${randomUUID()}@example.invalid`);
	expect((await confirm(current, token)).status).toBe(200);
	expect(await auth.api.twoFactorStatus({ headers: pending })).toEqual({
		pending: false,
	});
	expect(
		(
			await auth.api.verifyTOTP({
				headers: pending,
				body: { code: authenticatorCode(enabled.totpURI) },
				asResponse: true,
			})
		).ok,
	).toBe(false);
	expect((await identity(current))?.user.twoFactorEnabled).toBe(true);
});
