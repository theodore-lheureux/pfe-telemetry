import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import type { OperationResult } from "../../src/organizations/contracts";

import { trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";

export function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

async function createWorkspace(parallelIndex: number) {
	const timings: Record<string, number> = {};
	async function measure<T>(name: string, action: () => Promise<T>) {
		const started = performance.now();
		try {
			return await action();
		} finally {
			timings[name] = Math.round(performance.now() - started);
		}
	}
	const port = Number(process.env.RECOUNT_BROWSER_PORT ?? 3554) + parallelIndex;
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(
			"RECOUNT_BROWSER_PORT must leave a valid port for each worker",
		);
	const database = await measure("databaseSetupMs", () =>
		createTestDatabase("browser"),
	);
	const url = new URL(database.url);
	const origin = `http://localhost:${port}`;
	const secret = `browser-test-only-${randomUUID()}`;
	const codes = new Map<string, string>();
	const auth = createAuth(
		{ origin, secret, rpID: "localhost", allowSignUp: true },
		database.db,
		{
			sendSignInCode: async (email, code) => {
				codes.set(email, code);
			},
			sendOrganizationInvitation: async () => {},
		},
	);
	const operations = actorService(auth);
	let server: ReturnType<typeof spawn> | undefined;
	let serverOutput = "";
	const pendingAuth = new Set<Promise<unknown>>();
	let closing = false;
	async function ownAuth<T>(action: () => Promise<T>): Promise<T> {
		if (closing) throw new Error("Browser authentication fixture is closing");
		const task = action();
		pendingAuth.add(task);
		try {
			return await task;
		} finally {
			pendingAuth.delete(task);
		}
	}
	async function close() {
		closing = true;
		try {
			await measure("serverCloseMs", async () => {
				if (
					server?.pid &&
					server.exitCode === null &&
					server.signalCode === null
				) {
					process.kill(-server.pid, "SIGTERM");
					try {
						await once(server, "exit", { signal: AbortSignal.timeout(35_000) });
					} catch {
						process.kill(-server.pid, "SIGKILL");
						await once(server, "exit", { signal: AbortSignal.timeout(2_000) });
					}
				}
			});
		} finally {
			try {
				await measure("authDrainMs", async () => {
					while (pendingAuth.size) await Promise.allSettled([...pendingAuth]);
					await auth.emailDelivery.close();
				});
			} finally {
				await measure("databaseCloseMs", () => database.close());
			}
		}
	}
	try {
		const serverEnvironment = { ...process.env };
		for (const key of [
			"CLICKHOUSE_ADMIN_PASSWORD",
			"RECOUNT_INGESTION_DATABASE_URL",
			"RECOUNT_INGESTION_PASSWORD",
			"TEST_DATABASE_URL",
		])
			delete serverEnvironment[key];
		for (const key of Object.keys(serverEnvironment))
			if (
				[
					"RECOUNT_CLICKHOUSE_TEST_",
					"RECOUNT_STORAGE_TEST_",
					"RECOUNT_NORMALIZER_TEST_",
					"RECOUNT_RUNTIME_",
					"RECOUNT_PIPELINE_",
				].some((prefix) => key.startsWith(prefix))
			)
				delete serverEnvironment[key];
		server = spawn(
			"bun",
			[
				"--no-env-file",
				...(process.env.RECOUNT_BROWSER_BUILT === "true"
					? [".output/server/index.mjs"]
					: ["--bun", "run", "dev", "--port", String(port)]),
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: {
					...serverEnvironment,
					NODE_ENV:
						process.env.RECOUNT_BROWSER_BUILT === "true"
							? "production"
							: "development",
					DATABASE_URL: url.toString(),
					NITRO_HOST: "127.0.0.1",
					NITRO_PORT: String(port),
					BETTER_AUTH_URL: origin,
					BETTER_AUTH_SECRET: secret,
					RECOUNT_AUTH_ALLOW_SIGN_UP: "true",
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
		await measure("serverReadyMs", () =>
			expect
				.poll(
					async () => {
						if (
							!server ||
							server.exitCode !== null ||
							server.signalCode !== null
						)
							throw new Error("Browser test server exited");
						try {
							const response = await fetch(`${origin}/login`, {
								headers: { Connection: "close" },
								signal: AbortSignal.timeout(2_000),
							});
							await response.arrayBuffer();
							return response.status;
						} catch {
							return 0;
						}
					},
					{ timeout: 20_000 },
				)
				.toBe(200),
		);
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
		timings,
		origin,
		databaseUrl: url.toString(),
		codes,
		database,
		auth,
		operations,
		close,
		async enableCodeDelivery(page: Page) {
			await page.route(
				"**/api/auth/email-otp/send-verification-otp",
				async (route) => {
					const incoming = route.request();
					const response = await ownAuth(async () => {
						const headers = await incoming.allHeaders();
						return auth.handler(
							new Request(incoming.url(), {
								method: incoming.method(),
								headers,
								body: incoming.postData(),
							}),
						);
					});
					await auth.emailDelivery.drain();
					await route.fulfill({
						status: response.status,
						headers: Object.fromEntries(response.headers),
						body: await response.text(),
					});
				},
			);
		},
		async submitReceivedCode(page: Page, email: string, locale: Locale = "en") {
			const input = page.getByLabel(m.signin_code({}, { locale }), {
				exact: true,
			});
			await input.waitFor();
			const code = codes.get(email.toLowerCase());
			if (!code) throw new Error("Expected an in-memory email code");
			await input.evaluate((element, value) => {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set;
				if (!setter) throw new Error("Input setter unavailable");
				setter.call(element, value);
				element.dispatchEvent(new Event("input", { bubbles: true }));
			}, code);
			await page
				.getByRole("button", {
					name: m.verify_code({}, { locale }),
					exact: true,
				})
				.click();
		},
		async signIn(page: Page, email: string) {
			const response = await ownAuth(() =>
				trustedCodeSignIn(
					auth,
					email,
					(email) => codes.get(email),
					new Headers({ origin }),
				),
			);
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
	workspace: async ({}, use, testInfo) => {
		const workspace = await createWorkspace(testInfo.parallelIndex);
		try {
			await use(workspace);
		} finally {
			try {
				await workspace.close();
			} finally {
				await testInfo.attach("workspace-timings", {
					body: JSON.stringify(workspace.timings),
					contentType: "application/json",
				});
			}
		}
	},
	// Retire the browser's connections before draining its isolated application.
	page: async ({ page, workspace: _workspace }, use) => {
		try {
			await use(page);
		} finally {
			await page.context().close();
		}
	},
});
test.afterEach(async ({ page }) => {
	// Clear codes before failed-page accessibility snapshots can retain them.
	await page
		.evaluate(() => {
			for (const input of document.querySelectorAll<HTMLInputElement>(
				'input[autocomplete="one-time-code"]',
			))
				input.value = "";
		})
		.catch(() => {});
	// Keep page closure in afterEach, before fixture teardown and failure artifacts.
	await page.close();
});

export { expect };
