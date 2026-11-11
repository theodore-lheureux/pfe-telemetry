import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { accountContextHeader } from "../../src/auth/account-context";
import type { createAuth } from "../../src/auth/create-auth.server";
import { session } from "../../src/db/schema";
import { gate } from "../gate";
import { authenticatorCode } from "../totp";
import { expect, test } from "./fixtures";

async function deliverStepUpCodes(
	page: Page,
	workspace: { auth: ReturnType<typeof createAuth> },
) {
	await page.route("**/api/reauthentication", async (route) => {
		const input = route.request().postDataJSON();
		if (input.action !== "send") return route.continue();
		const headers = new Headers(route.request().headers());
		const actor = await workspace.auth.api.getSession({ headers });
		if (!actor || actor.user.id !== input.userId)
			return route.fulfill({ status: 403, json: { code: "ACCOUNT_CHANGED" } });
		await workspace.auth.api.sendVerificationOTP({
			headers,
			body: { email: actor.user.email, type: "sign-in" },
		});
		await workspace.auth.emailDelivery.drain();
		await route.fulfill({ json: { sent: true } });
	});
}

test("an older session can view devices and an email verification popup resumes 2FA setup without leaving settings", async ({
	page,
	workspace,
}) => {
	const email = "step-up-email@example.invalid";
	const account = await workspace.signIn(page, email);
	const current = await workspace.auth.api.getSession({
		headers: account.headers,
	});
	if (!current) throw new Error("Expected an authenticated fixture");
	await workspace.database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, current.session.id));
	const url = `${workspace.origin}/settings?section=user`;
	await page.goto(url);
	await expect(
		page
			.getByRole("region", { name: "Web sessions", exact: true })
			.getByRole("table"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Sign in again", exact: true }),
	).toHaveCount(0);
	const setupButton = page.getByRole("button", {
		name: "Set up two-factor authentication",
		exact: true,
	});
	await setupButton.click();
	const verify = page.getByRole("dialog", {
		name: "Verify your identity",
		exact: true,
	});
	await expect(verify).toHaveCSS("top", "32px");
	await page.keyboard.press("Escape");
	await expect(verify).toHaveCount(0);
	await expect(setupButton).toBeFocused();
	await setupButton.click();
	await deliverStepUpCodes(page, workspace);
	await verify
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		verify.getByLabel("Sign-in code", { exact: true }),
	).toBeVisible();
	const code = workspace.codes.get(email);
	if (!code) throw new Error("Expected a test email code");
	await verify
		.getByLabel("Sign-in code", { exact: true })
		.fill(code === "000000" ? "111111" : "000000");
	await verify
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(verify.getByRole("alert")).toBeVisible();
	await verify.getByLabel("Sign-in code", { exact: true }).fill(code);
	await verify
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(verify).toHaveCount(0);
	await expect(
		page
			.getByRole("dialog", {
				name: "Set up two-factor authentication",
				exact: true,
			})
			.getByRole("img", { name: "Authenticator setup QR code" }),
	).toBeVisible();
	await expect(page).toHaveURL(url);
});

test("email step-up retains the active session until the authenticator factor is verified", async ({
	page,
	workspace,
}) => {
	const email = "step-up-totp@example.invalid";
	const account = await workspace.signIn(page, email);
	const security = {
		origin: workspace.origin,
		[accountContextHeader]: account.userId,
	};
	const enabled = await page.request.post(
		`${workspace.origin}/api/auth/two-factor/enable`,
		{ headers: security, data: { method: "totp" } },
	);
	expect(enabled.status()).toBe(200);
	const enrollment = await enabled.json();
	const confirmed = await page.request.post(
		`${workspace.origin}/api/auth/two-factor/verify-totp`,
		{
			headers: security,
			data: { code: authenticatorCode(enrollment.totpURI), trustDevice: false },
		},
	);
	expect(confirmed.status()).toBe(200);
	const current = await (
		await page.request.get(`${workspace.origin}/api/auth/get-session`)
	).json();
	await workspace.database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, current.session.id));
	const url = `${workspace.origin}/settings?section=user`;
	await page.goto(url);
	await page
		.getByRole("button", { name: "Sign out other sessions", exact: true })
		.click();
	const verify = page.getByRole("dialog", {
		name: "Verify your identity",
		exact: true,
	});
	await deliverStepUpCodes(page, workspace);
	await verify
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		verify.getByLabel("Sign-in code", { exact: true }),
	).toBeVisible();
	const code = workspace.codes.get(email);
	if (!code) throw new Error("Expected a test email code");
	await verify.getByLabel("Sign-in code", { exact: true }).fill(code);
	await verify
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(
		verify.getByLabel("Authenticator code", { exact: true }),
	).toBeVisible();
	expect(
		(
			await (
				await page.request.get(`${workspace.origin}/api/auth/get-session`)
			).json()
		).session.id,
	).toBe(current.session.id);
	await verify
		.getByLabel("Authenticator code", { exact: true })
		.fill(authenticatorCode(enrollment.totpURI));
	await verify
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(verify).toHaveCount(0);
	await expect(
		page.getByText("Account security updated.", { exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(url);
});

test("verified passkey step-up resumes a compact rename popup without another factor", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() =>
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => false },
		),
	);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	);
	try {
		const account = await workspace.signIn(
			page,
			"step-up-passkey@example.invalid",
		);
		const url = `${workspace.origin}/settings?section=user`;
		await page.goto(url);
		await page.getByLabel("Passkey name", { exact: true }).fill("Device key");
		await page
			.getByRole("button", { name: "Add a passkey", exact: true })
			.click();
		await expect(
			page.getByRole("cell", { name: "Device key", exact: true }),
		).toBeVisible();
		const current = await workspace.auth.api.getSession({
			headers: account.headers,
		});
		if (!current) throw new Error("Expected a session");
		await workspace.database.db
			.update(session)
			.set({ createdAt: new Date(Date.now() - 700000) })
			.where(eq(session.id, current.session.id));
		await page.getByRole("button", { name: "Rename", exact: true }).click();
		const rename = page.getByRole("dialog", {
			name: "Rename passkey",
			exact: true,
		});
		await expect(rename).toHaveCSS("top", "32px");
		await expect(rename.locator("label")).toHaveClass(/sr-only/);
		await expect(
			rename.locator('[data-slot="dialog-description"]'),
		).toHaveCount(0);
		await rename
			.getByLabel("Passkey name", { exact: true })
			.fill("Renamed device");
		await rename.getByRole("button", { name: "Save", exact: true }).click();
		const verify = page.getByRole("dialog", {
			name: "Verify your identity",
			exact: true,
		});
		await verify
			.getByRole("button", { name: "Sign in with a passkey", exact: true })
			.click();
		await expect(verify).toHaveCount(0);
		await expect(
			page.getByRole("cell", { name: "Renamed device", exact: true }),
		).toBeVisible();
		await expect(page).toHaveURL(url);
	} finally {
		await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
		await cdp.detach();
	}
});

test("a recovered verification does not automatically perform the queued security action", async ({
	page,
	workspace,
}) => {
	const email = "step-up-interrupted@example.invalid";
	const account = await workspace.signIn(page, email);
	const current = await workspace.auth.api.getSession({
		headers: account.headers,
	});
	if (!current) throw new Error("Expected a session");
	await workspace.database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, current.session.id));
	await page.goto(`${workspace.origin}/settings?section=user`);
	let writes = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/auth/two-factor/enable")
			writes++;
	});
	await page
		.getByRole("button", {
			name: "Set up two-factor authentication",
			exact: true,
		})
		.click();
	const verify = page.getByRole("dialog", {
		name: "Verify your identity",
		exact: true,
	});
	await deliverStepUpCodes(page, workspace);
	await page.route("**/api/reauthentication", async (route) => {
		if (route.request().postDataJSON().action !== "email")
			return route.fallback();
		const response = await route.fetch();
		expect(await response.json()).toEqual({ verified: true });
		await route.fulfill({ response, body: "{" });
	});
	await verify
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		verify.getByLabel("Sign-in code", { exact: true }),
	).toBeVisible();
	const code = workspace.codes.get(email);
	if (!code) throw new Error("Expected a test code");
	await verify.getByLabel("Sign-in code", { exact: true }).fill(code);
	await verify
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(verify).toHaveCount(0);
	await expect(page.getByRole("status")).toContainText(
		"the previous action was not performed",
	);
	expect(writes).toBe(0);
	await page
		.getByRole("button", {
			name: "Set up two-factor authentication",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("dialog", {
			name: "Set up two-factor authentication",
			exact: true,
		}),
	).toBeVisible();
	expect(writes).toBe(1);
});

test("an external account-change notification retires a queued step-up action before its response arrives", async ({
	page,
	workspace,
}) => {
	const email = "step-up-retired@example.invalid";
	const account = await workspace.signIn(page, email);
	const current = await workspace.auth.api.getSession({
		headers: account.headers,
	});
	if (!current) throw new Error("Expected a session");
	await workspace.database.db
		.update(session)
		.set({ createdAt: new Date(Date.now() - 700000) })
		.where(eq(session.id, current.session.id));
	await page.goto(`${workspace.origin}/settings?section=user`);
	const peer = await page.context().newPage();
	const ready = gate();
	const release = gate();
	const delivered = gate();
	let writes = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/auth/two-factor/enable")
			writes++;
	});
	await deliverStepUpCodes(page, workspace);
	await page.route("**/api/reauthentication", async (route) => {
		if (route.request().postDataJSON().action !== "email")
			return route.fallback();
		const response = await route.fetch();
		ready.release();
		await release.promise;
		await route.fulfill({ response }).catch(() => {});
		delivered.release();
	});
	try {
		await page
			.getByRole("button", {
				name: "Set up two-factor authentication",
				exact: true,
			})
			.click();
		const verify = page.getByRole("dialog", {
			name: "Verify your identity",
			exact: true,
		});
		await verify
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await expect(
			verify.getByLabel("Sign-in code", { exact: true }),
		).toBeVisible();
		const code = workspace.codes.get(email);
		if (!code) throw new Error("Expected a test code");
		await verify.getByLabel("Sign-in code", { exact: true }).fill(code);
		await verify
			.getByRole("button", { name: "Verify and continue", exact: true })
			.click();
		await ready.promise;
		await workspace.signIn(peer, "step-up-other-account@example.invalid");
		await peer.goto(`${workspace.origin}/login`);
		await peer.evaluate(() =>
			localStorage.setItem(
				"better-auth.message",
				JSON.stringify({
					event: "session",
					data: { trigger: "getSession" },
					clientId: "reauth-peer",
					timestamp: Date.now(),
				}),
			),
		);
		await expect(verify).toHaveCount(0);
		release.release();
		await delivered.promise;
		await expect(
			page.getByRole("heading", { name: "Profile", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("dialog", {
				name: "Set up two-factor authentication",
				exact: true,
			}),
		).toHaveCount(0);
		expect(writes).toBe(0);
	} finally {
		release.release();
		await peer.close();
	}
});
