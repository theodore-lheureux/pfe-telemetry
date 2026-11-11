import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { actorService } from "../../src/auth/actor.server";
import { createAuth } from "../../src/auth/create-auth.server";
import { readSigningKey } from "../../src/collectors/tokens.server";
import { settingsCatalog } from "../../src/components/settings/settings-catalog";
import {
	type SettingsSection,
	settingsScopes,
	settingsSections,
} from "../../src/components/settings-links";
import type { OperationResult } from "../../src/lib/operation-result";
import { trustedCodeSignIn } from "../auth-actors";
import { createTestDatabase } from "../database";
import { settingsPath } from "../settings-path";

export function settingsUrl(scope: string, section?: SettingsSection) {
	const relative = scope.startsWith("/");
	const url = new URL(scope, "http://fixture.invalid");
	const parts = url.pathname.split("/");
	const organizationId = parts[1] === "organizations" ? parts[2] : undefined;
	const projectId = parts[3] === "projects" ? parts[4] : undefined;
	const path = settingsPath(
		section ??
			(projectId ? "project" : organizationId ? "organization" : "user"),
		{ organizationId, projectId },
	);
	return relative ? path : `${url.origin}${path}`;
}

export function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

const preferencesHistory = new WeakMap<Page, number>();

export async function openMemberActions(
	page: Page,
	email: string,
	locale: Locale = "en",
) {
	await page
		.getByRole("button", {
			name: m.settings_member_actions({ email }, { locale }),
			exact: true,
		})
		.click();
}

export async function editMemberRole(
	page: Page,
	email: string,
	locale: Locale = "en",
) {
	await openMemberActions(page, email, locale);
	await page
		.getByRole("menuitem", {
			name: m.settings_change_role({}, { locale }),
			exact: true,
		})
		.click();
}

export async function openInvitationForm(page: Page, locale: Locale = "en") {
	await page
		.getByRole("button", {
			name: m.settings_invite_member({}, { locale }),
			exact: true,
		})
		.click();
}

export async function openProjectGrant(
	page: Page,
	email: string,
	locale: Locale = "en",
) {
	const field = page.getByLabel(m.project_role_for({ email }, { locale }), {
		exact: true,
	});
	if (await field.count()) return;
	await page
		.getByRole("button", {
			name: m.project_add_member({}, { locale }),
			exact: true,
		})
		.click();
	const candidates = page.getByLabel(m.project_select_member({}, { locale }), {
		exact: true,
	});
	const value = await candidates
		.locator("option")
		.filter({ hasText: email })
		.getAttribute("value");
	if (!value) throw new Error("Expected eligible organization member");
	await candidates.selectOption(value);
	await expect(field).toBeEnabled();
}

export async function chooseTheme(
	page: Page,
	mode: "light" | "dark" | "system",
	locale: Locale = "en",
) {
	await page
		.getByRole("button", { name: m.theme({}, { locale }), exact: true })
		.click();
	const label =
		mode === "light"
			? m.theme_light
			: mode === "dark"
				? m.theme_dark
				: m.theme_system;
	await page
		.getByRole("menuitemradio", { name: label({}, { locale }), exact: true })
		.click();
}

export async function dismissPasskeySetup(page: Page, locale: Locale = "en") {
	const prompt = page.getByRole("dialog", {
		name: m.passkey_prompt_title({}, { locale }),
		exact: true,
	});
	await prompt
		.getByRole("button", {
			name: m.passkey_prompt_later({}, { locale }),
			exact: true,
		})
		.click();
	await expect(prompt).toHaveCount(0);
}

export async function openReauthentication(page: Page, redirect = "/") {
	// Keep the document and held responses alive; a hard reload would erase the race.
	await page.evaluate((redirect) => {
		history.pushState(
			null,
			"",
			`/login?redirect=${encodeURIComponent(redirect)}`,
		);
	}, redirect);
	await expect(
		page.getByLabel(m.email_address(), { exact: true }),
	).toBeVisible();
}

async function expandSettingsNavigation(page: Page, locale: Locale) {
	const navigation = page.getByRole("navigation", {
		name: m.settings_navigation({}, { locale }),
		exact: true,
	});
	await expect(navigation).toBeVisible();
	const summary = navigation.getByRole("button", {
		name: new RegExp(`^${m.settings({}, { locale })} ·`),
	});
	if (await summary.count()) {
		await expect(summary).toBeEnabled();
		if ((await summary.getAttribute("aria-expanded")) === "false")
			await summary.click();
	}
	await expect(
		navigation.getByRole("combobox", {
			name: m.search_settings({}, { locale }),
			exact: true,
		}),
	).toBeVisible();
}

export async function openPreferences(page: Page, locale: Locale = "en") {
	const original = page.url();
	await openWorkspaceMenu(page, locale);
	await page
		.getByRole("menuitem", {
			name: m.user_settings({}, { locale }),
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", {
			name: m.user_profile({}, { locale }),
			exact: true,
		}),
	).toBeVisible();
	const profile = page.url();
	await expandSettingsNavigation(page, locale);
	await page
		.getByRole("navigation", {
			name: m.settings_navigation({}, { locale }),
			exact: true,
		})
		.getByRole("link", {
			name: m.appearance_language({}, { locale }),
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", {
			name: m.appearance_language({}, { locale }),
			exact: true,
			level: 1,
		}),
	).toBeVisible();
	preferencesHistory.set(
		page,
		Number(original !== profile) + Number(profile !== page.url()),
	);
}

export async function closePreferences(page: Page) {
	const count = preferencesHistory.get(page) ?? 1;
	preferencesHistory.delete(page);
	for (let index = 0; index < count; index++) await page.goBack();
}

export async function openWorkspaceMenu(page: Page, locale: Locale = "en") {
	const trigger = page.getByRole("button", {
		name: m.switch_workspace({}, { locale }),
		exact: true,
	});
	if (
		(page.viewportSize()?.width ?? 1280) < 768 &&
		!(await page
			.locator('[data-slot="sidebar"][data-mobile="true"][data-state="open"]')
			.count())
	)
		await page
			.getByRole("button", {
				name: m.open_navigation({}, { locale }),
				exact: true,
				includeHidden: true,
			})
			.click();
	await trigger.click();
}

export async function chooseOrganization(
	page: Page,
	name: string,
	locale: Locale = "en",
) {
	await openWorkspaceMenu(page, locale);
	await page
		.getByRole("menuitem", {
			name: m.choose_organization({}, { locale }),
			exact: true,
		})
		.click();
	await page
		.getByRole("combobox", {
			name: m.search_organizations({}, { locale }),
			exact: true,
		})
		.fill(name);
	await page.getByRole("option", { name, exact: true }).click();
}

export async function chooseProject(
	page: Page,
	name: string,
	locale: Locale = "en",
) {
	await openWorkspaceMenu(page, locale);
	await page
		.getByRole("menuitem", {
			name: m.choose_project({}, { locale }),
			exact: true,
		})
		.click();
	await page
		.getByRole("combobox", {
			name: m.search_projects({}, { locale }),
			exact: true,
		})
		.fill(name);
	await page.getByRole("option", { name, exact: true }).click();
}

export async function openSettingsSection(
	page: Page,
	name: string,
	locale: Locale = "en",
) {
	const link = page
		.getByRole("navigation", {
			name: m.settings_navigation({}, { locale }),
			exact: true,
		})
		.getByRole("link", { name, exact: true });
	if (await link.count()) {
		await expandSettingsNavigation(page, locale);
		return link.click();
	}
	await openWorkspaceMenu(page, locale);
	const section = settingsSections.find(
		(section) => settingsCatalog[section].label({}, { locale }) === name,
	);
	const scope = section && settingsScopes[section];
	const parent =
		scope === "project"
			? m.project_settings({}, { locale })
			: scope === "organization"
				? m.organization_settings({}, { locale })
				: scope === "user"
					? m.user_settings({}, { locale })
					: name;
	await page.getByRole("menuitem", { name: parent, exact: true }).click();
	if (
		section ||
		[
			m.project_settings({}, { locale }),
			m.organization_settings({}, { locale }),
			m.user_settings({}, { locale }),
		].some((label) => label === name)
	) {
		await expect(
			page.getByRole("navigation", {
				name: m.settings_navigation({}, { locale }),
				exact: true,
			}),
		).toBeVisible();
	}
	if (parent !== name) {
		await expandSettingsNavigation(page, locale);
		await link.click();
	}
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
	const collectorSigningKey = randomBytes(32).toString("base64url");
	const collectorPublicKey = readSigningKey({
		RECOUNT_COLLECTOR_SIGNING_KEY: collectorSigningKey,
	}).publicJwk.x;
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
					RECOUNT_COLLECTOR_SIGNING_KEY: collectorSigningKey,
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
		collectorPublicKey,
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
			await page.route("https://gravatar.com/avatar/**", (route) =>
				route.fulfill({ status: 404, body: "" }),
			);
			await page.route("https://avatars.example.invalid/**", (route) =>
				route.fulfill({ status: 404, body: "" }),
			);
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
