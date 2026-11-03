import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import type { AuthConfig } from "../../src/auth/config.server";
import { createAuth } from "../../src/auth/create-auth.server";
import { createDatabase } from "../../src/db/client.server";
import { passkey } from "../../src/db/schema";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error("TEST_DATABASE_URL is required");
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const config: AuthConfig = {
	origin: "http://localhost:3001",
	rpID: "localhost",
	secret: `test-only-auth-secret-${randomUUID()}`,
	allowSignUp: true,
};
let databaseName: string;
let database: ReturnType<typeof createDatabase>;
let sentLinks: { email: string; url: string }[];

function auth(allowSignUp = true) {
	return createAuth(
		{ ...config, allowSignUp },
		database.db,
		async (email, url) => {
			sentLinks.push({ email, url });
		},
	);
}

beforeEach(async () => {
	databaseName = `pfe_auth_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	await applyMigrations(url.toString());
	database = createDatabase({ connectionString: url.toString(), max: 2 });
	sentLinks = [];
});

afterEach(async () => {
	await database?.pool.end();
	await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
});

afterAll(async () => {
	await admin.end();
});

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

async function requestLink(
	instance: ReturnType<typeof auth>,
	email = "user@example.com",
) {
	const response = await instance.handler(
		post("/sign-in/magic-link", { email, callbackURL: "/account" }),
	);
	expect(response.status).toBe(200);
	const link = sentLinks.at(-1);
	if (!link) throw new Error("Expected a sign-in email");
	return link.url;
}

async function signIn(instance: ReturnType<typeof auth>) {
	const url = await requestLink(instance);
	const response = await instance.handler(new Request(url));
	expect(response.status).toBe(302);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
}

describe("passwordless account security", () => {
	test("verifies email once and invalidates the session on logout", async () => {
		const instance = auth();
		const url = await requestLink(instance);
		const token = new URL(url).searchParams.get("token");
		if (!token) throw new Error("Expected a sign-in token");
		const stored = await database.db.execute(
			sql`SELECT identifier FROM app.verification`,
		);
		expect(JSON.stringify(stored.rows)).not.toContain(token);
		const results = await Promise.all([
			instance.handler(new Request(url)),
			instance.handler(new Request(url)),
		]);
		const successful = results.filter((response) =>
			response.headers.has("set-cookie"),
		);
		expect(successful).toHaveLength(1);
		const cookie = successful[0].headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		expect(successful[0].headers.get("set-cookie")).toContain("HttpOnly");
		const session = await instance.api.getSession({
			headers: new Headers({ cookie }),
		});
		expect(session?.user.emailVerified).toBe(true);
		expect(session?.user.email).toBe("user@example.com");
		expect((await instance.handler(post("/sign-out", {}, cookie))).status).toBe(
			200,
		);
		expect(
			await instance.api.getSession({ headers: new Headers({ cookie }) }),
		).toBeNull();
	});

	test("closed registration rejects new accounts but permits existing users", async () => {
		const closed = auth(false);
		const deniedUrl = await requestLink(closed);
		const denied = await closed.handler(new Request(deniedUrl));
		expect(denied.headers.get("location")).toContain(
			"new_user_signup_disabled",
		);
		expect(
			(await database.db.execute(sql`SELECT id FROM app.user`)).rows,
		).toHaveLength(0);
		await signIn(auth());
		const cookie = await signIn(closed);
		expect(
			await closed.api.getSession({ headers: new Headers({ cookie }) }),
		).not.toBeNull();
	});

	test("rejects cross-origin requests and external callback destinations", async () => {
		const instance = auth();
		expect(
			(
				await instance.handler(
					post(
						"/sign-in/magic-link",
						{ email: "user@example.com" },
						"",
						"https://attacker.example",
					),
				)
			).status,
		).toBe(403);
		expect(
			(
				await instance.handler(
					post("/sign-in/magic-link", {
						email: "user@example.com",
						callbackURL: "https://attacker.example",
					}),
				)
			).status,
		).toBe(403);
		expect(sentLinks).toHaveLength(0);
		expect(
			(
				await instance.handler(
					post("/sign-up/email", {
						email: "user@example.com",
						password: "not-supported",
						name: "User",
					}),
				)
			).ok,
		).toBe(false);
	});

	test("rejects expired links and enforces recent authentication on passkey deletion", async () => {
		const instance = auth();
		const url = await requestLink(instance);
		await database.db.execute(
			sql`UPDATE app.verification SET expires_at = now() - interval '1 minute'`,
		);
		const expired = await instance.handler(new Request(url));
		expect(expired.headers.get("location")).toContain("INVALID_TOKEN");
		const cookie = await signIn(instance);
		const options = await instance.handler(
			new Request(
				`${config.origin}/api/auth/passkey/generate-register-options`,
				{ headers: { cookie } },
			),
		);
		expect(options.ok).toBe(true);
		const registration = await options.json();
		expect(registration.rp.id).toBe("localhost");
		expect(registration.authenticatorSelection.userVerification).toBe(
			"required",
		);
		const session = await instance.api.getSession({
			headers: new Headers({ cookie }),
		});
		if (!session) throw new Error("Expected an authenticated session");
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
			post("/passkey/delete-passkey", { id: key.id }, cookie),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ status: true });
		expect((await database.db.select().from(passkey)).length).toBe(0);
		await database.db.insert(passkey).values(key);
		await database.db.execute(
			sql`UPDATE app.session SET created_at = now() - interval '20 minutes'`,
		);
		const denied = await instance.handler(
			post("/passkey/delete-passkey", { id: key.id }, cookie),
		);
		expect(denied.status).toBe(403);
		expect((await denied.json()).code).toBe("SESSION_NOT_FRESH");
		expect((await database.db.select().from(passkey)).length).toBe(1);
	});

	test("shares email request rate limits between application instances", async () => {
		for (let index = 0; index < 5; index++) await requestLink(auth());
		const limited = await auth().handler(
			post("/sign-in/magic-link", { email: "user@example.com" }),
		);
		expect(limited.status).toBe(429);
		expect(sentLinks).toHaveLength(5);
	});
});
