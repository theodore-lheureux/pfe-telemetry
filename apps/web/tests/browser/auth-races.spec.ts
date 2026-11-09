import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { passkey } from "../../src/db/schema";
import {
	dismissPasskeySetup,
	expect,
	openSettingsSection,
	settingsUrl,
	test,
} from "./fixtures";

const gates = new Set<() => void>();
test.afterEach(async () => {
	for (const release of gates) release();
	gates.clear();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	gates.add(resolve);
	return {
		promise,
		resolve: () => {
			gates.delete(resolve);
			resolve();
		},
	};
}
function receivedCode(codes: Map<string, string>, email: string) {
	const code = codes.get(email);
	if (!code) throw new Error("Expected an in-memory email code");
	return code;
}

for (const committed of [false, true]) {
	const phase = committed
		? "after commit with dropped headers"
		: "before commit";
	test(`verification deadline aborts ${phase} before account switch`, async ({
		page,
		workspace,
	}) => {
		test.setTimeout(120_000);
		await page.clock.install();
		await page.addInitScript(() => {
			Object.defineProperty(
				PublicKeyCredential,
				"isConditionalMediationAvailable",
				{ configurable: true, value: async () => false },
			);
		});
		const actor = await workspace.signIn(page, "deadline-a@example.invalid");
		await workspace.enableCodeDelivery(page);
		const before = await workspace.database.db.execute<{ count: string }>(
			sql`SELECT count(*)::text AS count FROM app.session`,
		);
		const held = deferred();
		const release = deferred();
		const delivered = deferred();
		let posts = 0;
		let aborted = 0;
		page.on("requestfailed", (request) => {
			if (new URL(request.url()).pathname === "/api/auth/sign-in/email-otp")
				aborted++;
		});
		await page.route("**/api/auth/sign-in/email-otp", async (route) => {
			if (++posts !== 1) return route.continue();
			const response = committed ? await route.fetch() : undefined;
			if (response) {
				expect(response.ok()).toBe(true);
				// Playwright's API context accepts Set-Cookie; restore the browser's dropped-header state.
				await restoreCookie(page, workspace.origin, actor.headers);
			}
			held.resolve();
			await release.promise;
			try {
				await route.fulfill(
					response ? { response } : { status: 200, json: {} },
				);
			} catch {
				/* An aborted browser transport may already have discarded this route. */
			} finally {
				delivered.resolve();
			}
		});
		await openCode(page, workspace.origin, "deadline-a@example.invalid");
		await workspace.submitReceivedCode(page, "deadline-a@example.invalid");
		await held.promise;
		await page.clock.fastForward(30_001);
		await expect(
			page.getByRole("button", { name: "Check sign-in status", exact: true }),
		).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => aborted).toBe(1);
		expect(posts).toBe(1);
		await page
			.getByRole("button", { name: "Check sign-in status", exact: true })
			.click();
		await expect(page.getByRole("status")).toContainText("Request a new code");
		expect(posts).toBe(1);
		const after = await workspace.database.db.execute<{ count: string }>(
			sql`SELECT count(*)::text AS count FROM app.session`,
		);
		expect(Number(after.rows[0].count)).toBe(
			Number(before.rows[0].count) + Number(committed),
		);
		if (committed) {
			const replay = await workspace.auth.api.signInEmailOTP({
				body: {
					email: "deadline-a@example.invalid",
					otp: receivedCode(workspace.codes, "deadline-a@example.invalid"),
				},
				asResponse: true,
			});
			expect(replay.ok).toBe(false);
		}
		await page
			.getByRole("button", { name: "Change email address", exact: true })
			.click();
		await page
			.getByLabel("Email address", { exact: true })
			.fill("deadline-b@example.invalid");
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await workspace.submitReceivedCode(page, "deadline-b@example.invalid");
		await dismissPasskeySetup(page);
		await expect(
			page.getByRole("heading", { name: "Your organizations", exact: true }),
		).toBeVisible({ timeout: 30_000 });
		release.resolve();
		await delivered.promise;
		await openSettingsSection(page, "User settings");
		await expect(
			page.getByText("deadline-b@example.invalid", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("deadline-a@example.invalid", { exact: true }),
		).toHaveCount(0);
		expect(posts).toBe(2);
	});
}
async function restoreCookie(page: Page, origin: string, headers: Headers) {
	await page.context().clearCookies();
	await page.context().addCookies(
		(headers.get("cookie") ?? "")
			.split("; ")
			.filter(Boolean)
			.map((pair) => {
				const index = pair.indexOf("=");
				return {
					name: pair.slice(0, index),
					value: pair.slice(index + 1),
					url: origin,
					httpOnly: true,
					sameSite: "Lax" as const,
				};
			}),
	);
}
async function openCode(page: Page, origin: string, email: string) {
	await page.goto(`${origin}/login`);
	await page.getByLabel("Email address", { exact: true }).fill(email);
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Check your email", exact: true }),
	).toBeVisible({ timeout: 30_000 });
}

test("a committed OTP settles and reconciles identity after Login navigates away", async ({
	page,
	workspace,
}) => {
	await workspace.enableCodeDelivery(page);
	const committed = deferred();
	const release = deferred();
	let posts = 0;
	await page.route("**/api/auth/sign-in/email-otp", async (route) => {
		posts++;
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		committed.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	await openCode(page, workspace.origin, "late-otp@example.invalid");
	await workspace.submitReceivedCode(page, "late-otp@example.invalid");
	await committed.promise;
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.click();
	release.resolve();
	await dismissPasskeySetup(page);
	await expect(
		page.getByRole("heading", { name: "Your organizations", exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await openSettingsSection(page, "User settings");
	await expect(
		page.getByText("late-otp@example.invalid", { exact: true }),
	).toBeVisible();
	expect(posts).toBe(1);
	const replay = await workspace.auth.api.signInEmailOTP({
		body: {
			email: "late-otp@example.invalid",
			otp: receivedCode(workspace.codes, "late-otp@example.invalid"),
		},
		asResponse: true,
	});
	expect(replay.ok).toBe(false);
});

test("lost committed verification cannot reuse an existing same-email session as reauthentication", async ({
	page,
	workspace,
}) => {
	const actor = await workspace.signIn(page, "same-email@example.invalid");
	await workspace.enableCodeDelivery(page);
	const before = await workspace.database.db.execute<{ count: string }>(
		sql`SELECT count(*)::text AS count FROM app.session`,
	);
	let posts = 0;
	await page.route("**/api/auth/sign-in/email-otp", async (route) => {
		posts++;
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		// Drop the new cookie with the response, preserving the pre-submit session.
		await restoreCookie(page, workspace.origin, actor.headers);
		await route.abort();
	});
	await openCode(page, workspace.origin, "same-email@example.invalid");
	await workspace.submitReceivedCode(page, "same-email@example.invalid");
	await expect(
		page.getByRole("button", { name: "Check sign-in status", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Check sign-in status", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("Request a new code");
	expect(new URL(page.url()).pathname).toBe("/login");
	expect(posts).toBe(1);
	const after = await workspace.database.db.execute<{ count: string }>(
		sql`SELECT count(*)::text AS count FROM app.session`,
	);
	expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count) + 1);
	const replay = await workspace.auth.api.signInEmailOTP({
		body: {
			email: "same-email@example.invalid",
			otp: receivedCode(workspace.codes, "same-email@example.invalid"),
		},
		asResponse: true,
	});
	expect(replay.ok).toBe(false);
});

for (const failFresh of [false, true]) {
	test(`A-to-B OTP does not expose A passkeys after a late response${failFresh ? " or failed B refresh" : ""}`, async ({
		page,
		workspace,
	}) => {
		const a = await workspace.signIn(page, "keys-a@example.invalid");
		const b = await workspace.signIn(page, "keys-b@example.invalid");
		await workspace.database.db.insert(passkey).values([
			{
				id: "a-key",
				name: "Private A key",
				userId: a.userId,
				publicKey: "unused-for-list",
				credentialID: "a-credential",
				counter: 0,
				deviceType: "singleDevice",
				backedUp: false,
			},
			{
				id: "b-key",
				name: "Private B key",
				userId: b.userId,
				publicKey: "unused-for-list",
				credentialID: "b-credential",
				counter: 0,
				deviceType: "singleDevice",
				backedUp: false,
			},
		]);
		await restoreCookie(page, workspace.origin, a.headers);
		await page.goto(settingsUrl(workspace.origin, "user"));
		await expect(
			page.getByText("Private A key", { exact: true }),
		).toBeVisible();
		const held = deferred();
		const release = deferred();
		const delivered = deferred();
		let oldHeld = false;
		await page.route(
			"**/api/auth/passkey/list-user-passkeys**",
			async (route) => {
				if (!oldHeld) {
					oldHeld = true;
					const response = await route.fetch();
					held.resolve();
					await release.promise;
					try {
						await route.fulfill({ response });
					} catch {
						/* The previous account's query may already have been canceled. */
					} finally {
						delivered.resolve();
					}
					return;
				}
				if (failFresh)
					return route.fulfill({
						status: 503,
						json: { message: "Unavailable" },
					});
				await route.continue();
			},
		);
		await page
			.getByRole("button", { name: "Sign out other sessions", exact: true })
			.click();
		await held.promise;
		await workspace.enableCodeDelivery(page);
		await page
			.getByRole("link", { name: "Sign in again", exact: true })
			.click();
		await page
			.getByLabel("Email address", { exact: true })
			.fill("keys-b@example.invalid");
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await workspace.submitReceivedCode(page, "keys-b@example.invalid");
		await expect(
			page.getByRole("heading", { name: "Your organizations", exact: true }),
		).toBeVisible({ timeout: 30_000 });
		release.resolve();
		await delivered.promise;
		await openSettingsSection(page, "User settings");
		await expect(
			page.getByText("keys-b@example.invalid", { exact: true }),
		).toBeVisible();
		await expect(page.getByText("Private A key", { exact: true })).toHaveCount(
			0,
		);
		if (failFresh) {
			await expect(
				page.getByText("Could not load passkeys. Try refreshing the page.", {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByText("No passkeys registered yet.", { exact: true }),
			).toHaveCount(0);
		} else
			await expect(
				page.getByText("Private B key", { exact: true }),
			).toBeVisible();
	});
}

test("manual passkeys still verify without native credential JSON helpers", async ({
	page,
	workspace,
}) => {
	await workspace.signIn(page, "legacy-browser@example.invalid");
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await page.addInitScript(() => {
		Object.defineProperty(PublicKeyCredential, "parseRequestOptionsFromJSON", {
			configurable: true,
			value: undefined,
		});
		Object.defineProperty(PublicKeyCredential.prototype, "toJSON", {
			configurable: true,
			value: undefined,
		});
	});
	await page.goto(settingsUrl(workspace.origin, "user"));
	await page
		.getByLabel("Passkey name", { exact: true })
		.fill("Compatible browser key");
	await page
		.getByRole("button", { name: "Add a passkey", exact: true })
		.click();
	await expect(
		page.getByText("Compatible browser key", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page
		.getByRole("button", { name: "Sign in with a passkey", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Your organizations", exact: true }),
	).toBeVisible();
});

test("pagehide does not abort submitted verification and identity is reconciled before private navigation", async ({
	page,
	workspace,
}) => {
	await workspace.enableCodeDelivery(page);
	const committed = deferred();
	const release = deferred();
	let failed = false;
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/sign-in/email-otp")) failed = true;
	});
	await page.route("**/api/auth/sign-in/email-otp", async (route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		committed.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	await openCode(page, workspace.origin, "pagehide@example.invalid");
	await workspace.submitReceivedCode(page, "pagehide@example.invalid");
	await committed.promise;
	await page.evaluate(() =>
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		),
	);
	release.resolve();
	await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue(
		"",
	);
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.click();
	await dismissPasskeySetup(page);
	await expect(
		page.getByRole("heading", { name: "Your organizations", exact: true }),
	).toBeVisible();
	expect(failed).toBe(false);
	await openSettingsSection(page, "User settings");
	await expect(
		page.getByText("pagehide@example.invalid", { exact: true }),
	).toBeVisible();
});
