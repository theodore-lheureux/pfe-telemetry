import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountContextHeader } from "../../src/auth/account-context";
import { readAuthenticationState } from "../../src/auth/authentication-state.server";
import { createAuth } from "../../src/auth/create-auth.server";
import { handleReauthentication } from "../../src/auth/reauthentication.server";
import { session } from "../../src/db/schema";
import { trustedActor } from "../auth-actors";
import { createTestDatabase } from "../database";
import { authenticatorCode } from "../totp";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const origin = "http://localhost:3957";
const codes = new Map<string, string>();
beforeAll(async () => {
	database = await createTestDatabase("reauth");
	auth = createAuth(
		{
			origin,
			rpID: "localhost",
			secret: `reauth-test-${randomUUID()}`,
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
});
afterAll(async () => {
	await auth?.emailDelivery.close();
	await database?.close();
});
let actorSequence = 0;
const actor = () =>
	trustedActor(
		auth,
		`${randomUUID()}@example.invalid`,
		(email) => codes.get(email),
		new Headers({ origin, "x-forwarded-for": `198.51.100.${++actorSequence}` }),
	);
function cookies(headers: Headers, response: Response) {
	const next = new Headers(headers);
	const values = new Map(
		(headers.get("cookie") ?? "")
			.split(";")
			.filter(Boolean)
			.map((cookie) => {
				const [name, ...value] = cookie.trim().split("=");
				return [name, value.join("=")] as const;
			}),
	);
	for (const cookie of response.headers.getSetCookie()) {
		const [pair] = cookie.split(";");
		const [name, ...value] = pair.split("=");
		if (/max-age=0/i.test(cookie)) values.delete(name);
		else values.set(name, value.join("="));
	}
	next.set(
		"cookie",
		[...values].map(([name, value]) => `${name}=${value}`).join("; "),
	);
	return next;
}
function post(headers: Headers, body: object) {
	const next = new Headers(headers);
	next.set("Content-Type", "application/json");
	return handleReauthentication(
		new Request(`${origin}/api/reauthentication`, {
			method: "POST",
			headers: next,
			body: JSON.stringify(body),
		}),
		auth,
		origin,
	);
}

test("email step-up returns no tokens, requires the same account and produces a genuinely fresh session", async () => {
	const owner = await actor();
	const old = await auth.api.getSession({ headers: owner.headers });
	if (!old) throw new Error("Expected an authenticated fixture");
	await database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, old.session.id));
	expect(
		(
			await post(
				new Headers({
					origin: "https://attacker.invalid",
					cookie: owner.headers.get("cookie") ?? "",
				}),
				{ action: "send", userId: owner.id },
			)
		).status,
	).toBe(403);
	expect(
		(await post(owner.headers, { action: "send", userId: "different-account" }))
			.status,
	).toBe(403);
	const sent = await post(owner.headers, { action: "send", userId: owner.id });
	expect(sent.status).toBe(200);
	await auth.emailDelivery.drain();
	const completed = await post(owner.headers, {
		action: "email",
		userId: owner.id,
		code: codes.get(owner.email),
	});
	expect(await completed.clone().json()).toEqual({ verified: true });
	const renewed = await auth.api.getSession({
		headers: cookies(owner.headers, completed),
	});
	if (!renewed) throw new Error("Expected a renewed session");
	expect(renewed?.user.id).toBe(owner.id);
	expect(renewed?.session.id).not.toBe(old?.session.id);
	expect(renewed.session.createdAt.getTime()).toBeGreaterThan(
		Date.now() - 5000,
	);
	await expect(
		auth.api.listSessions({ headers: cookies(owner.headers, completed) }),
	).resolves.toBeArray();
	expect(
		(
			await post(owner.headers, {
				action: "email",
				userId: owner.id,
				code: codes.get(owner.email),
			})
		).status,
	).not.toBe(200);
	expect(
		(
			await post(owner.headers, {
				action: "passkey",
				userId: owner.id,
				response: { id: "another-account-key" },
			})
		).status,
	).toBe(403);
});

test("email step-up preserves the existing session until TOTP or a single-use recovery code succeeds", async () => {
	const owner = await actor();
	owner.headers.set(accountContextHeader, owner.id);
	const setup = await auth.api.enableTwoFactor({
		headers: owner.headers,
		body: { method: "totp" },
	});
	if (!("totpURI" in setup)) throw new Error("Expected TOTP enrollment");
	const enrolled = await auth.api.verifyTOTP({
		headers: owner.headers,
		body: { code: authenticatorCode(setup.totpURI), trustDevice: false },
		asResponse: true,
	});
	let headers = cookies(owner.headers, enrolled);
	const old = await auth.api.getSession({ headers });
	if (!old) throw new Error("Expected an enrolled fixture");
	await database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, old.session.id));
	for (const factor of ["totp", "backup"] as const) {
		const priorSessionId = (await auth.api.getSession({ headers }))?.session.id;
		const sent = await post(headers, { action: "send", userId: owner.id });
		expect(sent.status).toBe(200);
		await auth.emailDelivery.drain();
		const first = await post(headers, {
			action: "email",
			userId: owner.id,
			code: codes.get(owner.email),
		});
		expect(first.status).toBe(200);
		expect(await first.clone().json()).toEqual({ twoFactorRequired: true });
		headers = cookies(headers, first);
		const pending = await readAuthenticationState(headers, auth);
		expect(pending.twoFactorPending).toBe(true);
		expect(pending.session?.id).toBe(priorSessionId);
		expect((await auth.api.getSession({ headers }))?.session.id).toBe(
			priorSessionId,
		);
		await expect(auth.api.listSessions({ headers })).rejects.toMatchObject({
			body: { code: "SESSION_NOT_FRESH" },
		});
		const invalid = await post(headers, {
			action: factor,
			userId: owner.id,
			code: factor === "totp" ? "bad" : "invalid-recovery",
		});
		expect(invalid.status).not.toBe(200);
		const code =
			factor === "totp"
				? authenticatorCode(setup.totpURI)
				: setup.backupCodes[0];
		const verified = await post(headers, {
			action: factor,
			userId: owner.id,
			code,
		});
		expect(await verified.clone().json()).toEqual({ verified: true });
		headers = cookies(headers, verified);
		await expect(auth.api.listSessions({ headers })).resolves.toBeArray();
		const renewed = await auth.api.getSession({ headers });
		if (!renewed) throw new Error("Expected a renewed session");
		await database.db
			.update(session)
			.set({ createdAt: new Date(Date.now() - 700000) })
			.where(eq(session.id, renewed.session.id));
	}
});
