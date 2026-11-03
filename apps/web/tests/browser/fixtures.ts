import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { applyMigrations } from "../../scripts/migrations";
import { createAuth } from "../../src/auth/create-auth.server";
import { createDatabase } from "../../src/db/client.server";
import type { OperationResult } from "../../src/organizations/contracts";
import { createOrganizationRequests } from "../../src/organizations/request.server";

export function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function createWorkspace() {
	const adminUrl = process.env.TEST_DATABASE_URL;
	if (!adminUrl) throw new Error("TEST_DATABASE_URL is required");
	const admin = new Pool({ connectionString: adminUrl, max: 1 });
	const databaseName = `pfe_browser_${randomUUID().replaceAll("-", "")}`;
	try {
		await admin.query(`CREATE DATABASE "${databaseName}"`);
	} catch (error) {
		await admin.end();
		throw error;
	}
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	const database = createDatabase({ connectionString: url.toString(), max: 4 });
	const port = Number(process.env.PFE_BROWSER_PORT ?? 3554);
	const origin = `http://localhost:${port}`;
	const secret = `browser-test-only-${randomUUID()}`;
	const links = new Map<string, string>();
	const auth = createAuth(
		{ origin, secret, rpID: "localhost", allowSignUp: true },
		database.db,
		{
			sendSignInLink: async (email, link) => {
				links.set(email, link);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	const operations = createOrganizationRequests(database.db, auth);
	let server: ReturnType<typeof spawn> | undefined;
	let serverOutput = "";
	async function close() {
		try {
			if (
				server?.pid &&
				server.exitCode === null &&
				server.signalCode === null
			) {
				process.kill(-server.pid, "SIGTERM");
				try {
					await once(server, "exit", { signal: AbortSignal.timeout(5_000) });
				} catch {
					process.kill(-server.pid, "SIGKILL");
					await once(server, "exit", { signal: AbortSignal.timeout(2_000) });
				}
			}
		} finally {
			try {
				await database.pool.end();
			} finally {
				try {
					await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
				} finally {
					await admin.end();
				}
			}
		}
	}
	try {
		await applyMigrations(url.toString());
		server = spawn(
			"bun",
			[
				"--bun",
				"run",
				process.env.PFE_BROWSER_BUILT === "true" ? "preview" : "dev",
				"--port",
				String(port),
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: {
					...process.env,
					DATABASE_URL: url.toString(),
					BETTER_AUTH_URL: origin,
					BETTER_AUTH_SECRET: secret,
					AUTH_ALLOW_SIGN_UP: "true",
					SMTP_HOST: "127.0.0.1",
					SMTP_PORT: "31562",
					SMTP_USER: "test-only",
					SMTP_PASSWORD: "test-only",
					EMAIL_FROM: "tests@example.invalid",
				},
			},
		);
		const capture = (chunk: Buffer) => {
			serverOutput = (serverOutput + chunk.toString()).slice(-12_000);
		};
		server.stdout?.on("data", capture);
		server.stderr?.on("data", capture);
		await expect
			.poll(
				async () => {
					if (server?.exitCode !== null)
						throw new Error("Browser test server exited");
					try {
						return (await fetch(`${origin}/login`)).status;
					} catch {
						return 0;
					}
				},
				{ timeout: 20_000 },
			)
			.toBe(200);
	} catch (error) {
		console.error(
			serverOutput
				.replaceAll(url.toString(), "[test database]")
				.replaceAll(secret, "[test secret]"),
		);
		await close();
		throw error;
	}
	return {
		origin,
		links,
		database,
		auth,
		operations,
		close,
		async signIn(page: Page, email: string) {
			await auth.handler(
				new Request(`${origin}/api/auth/sign-in/magic-link`, {
					method: "POST",
					headers: {
						origin,
						"content-type": "application/json",
						"x-forwarded-for": "192.0.2.1",
					},
					body: JSON.stringify({ email, callbackURL: "/" }),
				}),
			);
			const link = links.get(email);
			if (!link) throw new Error("Expected an in-memory sign-in link");
			const response = await auth.handler(new Request(link));
			const cookies = response.headers.getSetCookie().map((cookie) => {
				const pair = cookie.split(";")[0];
				const separator = pair.indexOf("=");
				return {
					name: pair.slice(0, separator),
					value: pair.slice(separator + 1),
					url: origin,
					httpOnly: true,
					sameSite: "Lax" as const,
				};
			});
			await page.context().clearCookies();
			await page.context().addCookies(cookies);
			const headers = new Headers({
				origin,
				cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
			});
			const session = await auth.api.getSession({ headers });
			if (!session)
				throw new Error("Expected an authenticated browser fixture");
			return { headers, userId: session.user.id };
		},
	};
}

export const test = base.extend<{
	workspace: Awaited<ReturnType<typeof createWorkspace>>;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments.
	workspace: async ({}, use) => {
		const workspace = await createWorkspace();
		try {
			await use(workspace);
		} finally {
			await workspace.close();
		}
	},
});
export { expect };
