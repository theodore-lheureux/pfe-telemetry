import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuth } from "../../src/auth/create-auth.server";
import {
	listWebSessions,
	revokeWebSession,
	updateProfileName,
} from "../../src/auth/profile.server";
import { AUTH_FRESH_AGE_SECONDS } from "../../src/auth/session-policy";
import { session, user } from "../../src/db/schema";
import { operationResult } from "../../src/organizations/operation-result.server";
import { trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes = new Map<string, string>();
const origin = "http://localhost:3754";
async function signIn(email: string) {
	const reply = await trustedCodeSignIn(
		auth,
		email,
		(email) => codes.get(email),
		new Headers({ origin }),
	);
	return new Headers({
		origin,
		cookie: reply.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; "),
	});
}
beforeAll(async () => {
	database = await createTestDatabase("profile");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `test-profile-${crypto.randomUUID()}`,
			allowSignUp: true,
		},
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {
				throw new Error("Unexpected invitation");
			},
		},
	);
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});

test("profile writes bind the displayed identity and sessions expose no bearer tokens", async () => {
	const currentHeaders = await signIn("profile-owner@example.invalid");
	const otherHeaders = await signIn("profile-owner@example.invalid");
	const foreignHeaders = await signIn("profile-foreign@example.invalid");
	const current = await auth.api.getSession({ headers: currentHeaders });
	const other = await auth.api.getSession({ headers: otherHeaders });
	const foreign = await auth.api.getSession({ headers: foreignHeaders });
	if (!current || !other || !foreign)
		throw new Error("Expected synthetic authenticated sessions");
	expect(current.session.signInMethod).toBe("email-otp");
	await database.db
		.update(session)
		.set({ signInMethod: null })
		.where(eq(session.id, other.session.id));
	await updateProfileName(
		auth,
		currentHeaders,
		"  Updated Owner  ",
		current.user.id,
	);
	expect(
		(await auth.api.getSession({ headers: currentHeaders }))?.user.name,
	).toBe("Updated Owner");
	await expect(
		updateProfileName(auth, foreignHeaders, "Wrong account", current.user.id),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		updateProfileName(auth, new Headers(), "Anonymous", current.user.id),
	).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
	const sessions = await listWebSessions(auth, currentHeaders);
	expect(sessions).toHaveLength(2);
	expect(
		sessions.find((row) => row.id === current.session.id)?.signInMethod,
	).toBe("email-otp");
	expect(
		sessions.find((row) => row.id === other.session.id)?.signInMethod,
	).toBeNull();
	expect(
		sessions.filter((session) => session.current).map((session) => session.id),
	).toEqual([current.session.id]);
	expect(sessions.every((session) => session.userId === current.user.id)).toBe(
		true,
	);
	const serialized = JSON.stringify(sessions);
	for (const token of [
		current.session.token,
		other.session.token,
		foreign.session.token,
	])
		expect(serialized).not.toContain(token);
	expect(
		sessions.every(
			(session) =>
				session.createdAt instanceof Date && session.updatedAt instanceof Date,
		),
	).toBe(true);
	await expect(
		revokeWebSession(auth, currentHeaders, foreign.session.id),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(
		revokeWebSession(auth, currentHeaders, current.session.id),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await revokeWebSession(auth, currentHeaders, other.session.id);
	expect(await auth.api.getSession({ headers: otherHeaders })).toBeNull();
	expect(
		(await listWebSessions(auth, currentHeaders)).map((session) => session.id),
	).toEqual([current.session.id]);
	expect(await auth.api.getSession({ headers: foreignHeaders })).not.toBeNull();
	await database.db
		.update(user)
		.set({ emailVerified: false })
		.where(eq(user.id, foreign.user.id));
	await expect(
		updateProfileName(auth, foreignHeaders, "Unverified", foreign.user.id),
	).rejects.toMatchObject({
		code: "FORBIDDEN",
		reason: "VERIFIED_EMAIL_REQUIRED",
	});
	await database.db
		.update(session)
		.set({
			createdAt: new Date(Date.now() - (AUTH_FRESH_AGE_SECONDS + 1) * 1000),
		})
		.where(eq(session.id, current.session.id));
	await expect(listWebSessions(auth, currentHeaders)).rejects.toMatchObject({
		body: { code: "SESSION_NOT_FRESH" },
	});
	expect(
		(await operationResult(() => listWebSessions(auth, currentHeaders))).error
			?.code,
	).toBe("SESSION_NOT_FRESH");
});
