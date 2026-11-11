import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readAuthenticationState } from "../../src/auth/authentication-state.server";
import type { AuthConfig } from "../../src/auth/config.server";
import { createAuth } from "../../src/auth/create-auth.server";
import { createAuthEmailDelivery } from "../../src/auth/email-delivery.server";
import { readAuthSession } from "../../src/auth/session.server";
import { passkey } from "../../src/db/schema";
import { responseCookie as cookie, trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";
import { gate as createGate } from "../gate";

const config: AuthConfig = {
	origin: "http://localhost:36601",
	rpID: "localhost",
	secret: `test-only-${randomUUID()}`,
	allowSignUp: true,
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let sentCodes: { email: string; code: string; locale: string }[];
let instances: ReturnType<typeof createAuth>[];
function auth(allowSignUp = true) {
	const instance = createAuth({ ...config, allowSignUp }, database.db, {
		sendSignInCode: async (email, code, locale) => {
			sentCodes.push({ email, code, locale });
		},
		sendOrganizationInvitation: async () => {
			throw new Error("Unexpected invitation email");
		},
	});
	instances.push(instance);
	return instance;
}
beforeEach(async () => {
	instances = [];
	sentCodes = [];
	database = await createTestDatabase("auth");
}, 60_000);
afterEach(async () => {
	await Promise.all(
		instances.map((instance) => instance.emailDelivery.close()),
	);
	await database?.close();
}, 60_000);
function post(
	path: string,
	body: unknown,
	cookie = "",
	origin = config.origin,
) {
	return new Request(`${config.origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			cookie,
			"x-forwarded-for": "192.0.2.1",
		},
		body: JSON.stringify(body),
	});
}
async function requestCode(
	instance: ReturnType<typeof auth>,
	email: string,
	locale = "en",
) {
	const response = await instance.handler(
		post(
			"/email-otp/send-verification-otp",
			{ email, type: "sign-in" },
			`recount_locale=${locale}`,
		),
	);
	expect(response.status).toBe(200);
	await instance.emailDelivery.drain();
	const sent = sentCodes.filter((message) => message.email === email).at(-1);
	if (!sent) throw new Error("Expected an in-memory email code");
	return sent.code;
}
async function signIn(
	instance: ReturnType<typeof auth>,
	email = "user@example.invalid",
) {
	return cookie(
		await trustedCodeSignIn(
			instance,
			email,
			(email) =>
				sentCodes.filter((message) => message.email === email).at(-1)?.code,
		),
	);
}

test("email code creates one verified session, stores a hash and cannot be replayed", async () => {
	const instance = auth();
	const email = "new@example.invalid";
	const code = await requestCode(instance, email);
	expect(/^\d{6}$/.test(code)).toBe(true);
	const stored = await database.db.execute<{ value: string; expires_at: Date }>(
		sql`SELECT value, expires_at FROM app.verification`,
	);
	expect(stored.rows.some((row) => row.value.includes(code))).toBe(false);
	const expiry = new Date(stored.rows[0].expires_at).getTime() - Date.now();
	expect(expiry > 290_000 && expiry <= 300_000).toBe(true);
	const results = await Promise.all(
		[1, 2].map(() =>
			instance.handler(post("/sign-in/email-otp", { email, otp: code })),
		),
	);
	expect(results.filter((response) => response.ok)).toHaveLength(1);
	const success = results.find((response) => response.ok);
	if (!success) throw new Error("Expected one successful code verification");
	const session = await instance.api.getSession({
		headers: new Headers({ cookie: cookie(success) }),
	});
	expect(session?.user.emailVerified).toBe(true);
	expect(
		success.headers.getSetCookie().some((value) => value.includes("HttpOnly")),
	).toBe(true);
	expect(
		(await instance.handler(post("/sign-in/email-otp", { email, otp: code })))
			.ok,
	).toBe(false);
	expect(
		(await instance.handler(post("/sign-out", {}, cookie(success)))).ok,
	).toBe(true);
	expect(
		await instance.api.getSession({
			headers: new Headers({ cookie: cookie(success) }),
		}),
	).toBeNull();
});
test("email code rotation, expiry and attempt limit are enforced", async () => {
	const instance = auth();
	const email = "rotate@example.invalid";
	const first = await requestCode(instance, email);
	const latest = await requestCode(instance, email);
	if (first !== latest)
		expect(
			(
				await instance.handler(
					post("/sign-in/email-otp", { email, otp: first }),
				)
			).ok,
		).toBe(false);
	await database.db.execute(
		sql`UPDATE app.verification SET expires_at=now()-interval '1 second'`,
	);
	expect(
		(await instance.handler(post("/sign-in/email-otp", { email, otp: latest })))
			.ok,
	).toBe(false);
	const fresh = await requestCode(instance, "attempt@example.invalid");
	for (let index = 0; index < 3; index++)
		await instance.api.signInEmailOTP({
			body: {
				email: "attempt@example.invalid",
				otp: fresh === "000000" ? "111111" : "000000",
			},
			asResponse: true,
		});
	expect(
		(
			await instance.api.signInEmailOTP({
				body: { email: "attempt@example.invalid", otp: fresh },
				asResponse: true,
			})
		).ok,
	).toBe(false);
});
test("closed registration sends generic acknowledgements without waiting for SMTP", async () => {
	await signIn(auth(), "existing@example.invalid");
	const { promise: gate, release } = createGate();
	let completed = false;
	let started = false;
	const instance = createAuth({ ...config, allowSignUp: false }, database.db, {
		sendSignInCode: async () => {
			started = true;
			await gate;
			completed = true;
		},
		sendOrganizationInvitation: async () => {},
	});
	instances.push(instance);
	try {
		const existing = await instance.handler(
			post("/email-otp/send-verification-otp", {
				email: "existing@example.invalid",
				type: "sign-in",
			}),
		);
		const unknown = await instance.handler(
			post("/email-otp/send-verification-otp", {
				email: "unknown@example.invalid",
				type: "sign-in",
			}),
		);
		expect(existing.status).toBe(200);
		expect(unknown.status).toBe(200);
		expect(await existing.json()).toEqual(await unknown.json());
		expect(started).toBe(true);
		expect(completed).toBe(false);
	} finally {
		release();
		await instance.emailDelivery.drain();
	}
	expect(completed).toBe(true);
	expect(
		(
			await database.db.execute(
				sql`SELECT id FROM app."user" WHERE email='unknown@example.invalid'`,
			)
		).rows,
	).toHaveLength(0);
});
test("email delivery errors are owned and sanitized while HTTP acknowledgements stay generic", async () => {
	let failures = 0;
	const delivery = createAuthEmailDelivery(() => {
		failures++;
	});
	const instance = createAuth(
		config,
		database.db,
		{
			sendSignInCode: async () => {
				throw new Error("private transport diagnostics");
			},
			sendOrganizationInvitation: async () => {},
		},
		delivery,
	);
	instances.push(instance);
	const response = await instance.handler(
		post("/email-otp/send-verification-otp", {
			email: "delivery@example.invalid",
			type: "sign-in",
		}),
	);
	expect(response.status).toBe(200);
	await delivery.drain();
	expect(failures).toBe(1);
});
test("HTTP code throttling survives auth instances; fixture server APIs do not spend that budget", async () => {
	const instance = auth();
	for (let index = 0; index < 6; index++)
		await signIn(instance, `actor-${index}@example.invalid`);
	for (let index = 0; index < 3; index++)
		await requestCode(instance, `rate-${index}@example.invalid`);
	const limited = await auth().handler(
		post("/email-otp/send-verification-otp", {
			email: "rate-last@example.invalid",
			type: "sign-in",
		}),
	);
	expect(limited.status).toBe(429);
	expect(Number(limited.headers.get("X-Retry-After")) > 0).toBe(true);
});
test("database failures reject code requests without sending email", async () => {
	const instance = auth();
	const fault = spyOn(database.pool, "query").mockImplementation(() => {
		throw new Error("Test database unavailable");
	});
	try {
		// Database-backed throttling runs before Better Auth's response router.
		await expect(
			instance.handler(
				post("/email-otp/send-verification-otp", {
					email: "fault@example.invalid",
					type: "sign-in",
				}),
			),
		).rejects.toThrow();
		expect(fault).toHaveBeenCalled();
		await instance.emailDelivery.drain();
		expect(sentCodes).toHaveLength(0);
	} finally {
		fault.mockRestore();
	}
	for (const table of ["verification", "session", "user"]) {
		const result = await database.pool.query(
			`SELECT count(*)::int AS count FROM app.${table === "user" ? '"user"' : table}`,
		);
		expect(result.rows[0].count).toBe(0);
	}
});
test("session reads reject database failures instead of treating them as signed out", async () => {
	const instance = auth();
	const sessionCookie = await signIn(instance, "rpc-fault@example.invalid");
	const headers = new Headers({ cookie: sessionCookie });
	const fault = spyOn(database.pool, "query").mockImplementation(() => {
		throw new Error("Test database unavailable");
	});
	try {
		for (const operation of [
			() => readAuthSession(instance, headers),
			() => readAuthenticationState(headers, instance),
		]) {
			await expect(operation()).rejects.toThrow();
		}
	} finally {
		fault.mockRestore();
	}
});
test("email code delivery preserves request locale and rejects other purposes and cross-origin sign-in", async () => {
	const instance = auth();
	await Promise.all([
		requestCode(instance, "en@example.invalid", "en"),
		requestCode(instance, "fr@example.invalid", "fr"),
	]);
	expect(
		sentCodes
			.map(({ email, locale }) => ({ email, locale }))
			.sort((a, b) => a.email.localeCompare(b.email)),
	).toEqual([
		{ email: "en@example.invalid", locale: "en" },
		{ email: "fr@example.invalid", locale: "fr" },
	]);
	expect(
		(
			await instance.handler(
				post("/email-otp/send-verification-otp", {
					email: "purpose@example.invalid",
					type: "forget-password",
				}),
			)
		).status,
	).toBe(400);
	expect(
		(
			await instance.handler(
				post(
					"/sign-in/email-otp",
					{ email: "en@example.invalid", otp: "000000" },
					"",
					"https://attacker.example",
				),
			)
		).status,
	).toBe(403);
	expect(
		(
			await instance.handler(
				post("/email-otp/request-password-reset", {
					email: "en@example.invalid",
				}),
			)
		).status,
	).toBe(404);
	expect(
		(
			await instance.handler(
				post("/sign-up/email", {
					email: "en@example.invalid",
					password: "disabled",
					name: "User",
				}),
			)
		).ok,
	).toBe(false);
});
test("existing verified users can reauthenticate with registration closed and passkey changes require freshness", async () => {
	await signIn(auth());
	const instance = auth(false);
	const sessionCookie = await signIn(instance);
	const options = await instance.handler(
		new Request(`${config.origin}/api/auth/passkey/generate-register-options`, {
			headers: { cookie: sessionCookie },
		}),
	);
	expect(options.ok).toBe(true);
	const registration = await options.json();
	expect(registration.rp.id).toBe("localhost");
	expect(registration.authenticatorSelection.userVerification).toBe("required");
	expect(registration.authenticatorSelection.residentKey).toBe("required");
	const session = await instance.api.getSession({
		headers: new Headers({ cookie: sessionCookie }),
	});
	if (!session) throw new Error("Expected fixture session");
	const key = {
		id: "owned-passkey",
		userId: session.user.id,
		publicKey: "unused-for-deletion",
		credentialID: "owned-credential",
		counter: 0,
		deviceType: "singleDevice",
		backedUp: false,
	};
	await database.db.insert(passkey).values(key);
	const removed = await instance.handler(
		post("/passkey/delete-passkey", { id: key.id }, sessionCookie),
	);
	expect(removed.status).toBe(200);
	expect(await removed.json()).toEqual({ status: true });
	expect((await database.db.select().from(passkey)).length).toBe(0);
	await database.db.insert(passkey).values(key);
	await database.db.execute(
		sql`UPDATE app.session SET created_at=now()-interval '20 minutes'`,
	);
	const denied = await instance.handler(
		post("/passkey/delete-passkey", { id: key.id }, sessionCookie),
	);
	expect(denied.status).toBe(403);
	expect((await denied.json()).code).toBe("SESSION_NOT_FRESH");
	const rename = await instance.handler(
		post(
			"/passkey/update-passkey",
			{ id: key.id, name: "Changed" },
			sessionCookie,
		),
	);
	expect(rename.status).toBe(403);
	expect((await rename.json()).code).toBe("SESSION_NOT_FRESH");
	expect((await database.db.select().from(passkey)).length).toBe(1);
});

test.each(["wrong", "unknown", "expired", "exhausted"] as const)(
	"public email-code failure is uniform for %s",
	async (kind) => {
		const email = "privacy@example.invalid";
		if (kind !== "unknown") await signIn(auth(), email);
		const instance = auth(false);
		await instance.api.sendVerificationOTP({
			body: { email, type: "sign-in" },
		});
		await instance.emailDelivery.drain();
		const code = sentCodes
			.filter((message) => message.email === email)
			.at(-1)?.code;
		const wrong = code === "000000" ? "111111" : "000000";
		if (kind === "expired")
			await database.db.execute(
				sql`UPDATE app.verification SET expires_at=now()-interval '1 second'`,
			);
		if (kind === "exhausted") {
			for (let index = 0; index < 3; index++)
				await instance.api.signInEmailOTP({
					body: { email, otp: wrong },
					asResponse: true,
				});
		}
		const response = await instance.handler(
			post("/sign-in/email-otp", {
				email,
				otp: kind === "wrong" || !code ? wrong : code,
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: "INVALID_OTP",
			message: "Invalid or expired code",
		});
	},
);
