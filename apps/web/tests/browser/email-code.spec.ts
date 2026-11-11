import type { Page } from "@playwright/test";
import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { gate as createGate } from "../gate";
import { dismissPasskeySetup, expect, test } from "./fixtures";

async function enterCode(page: Page, code: string, locale: Locale = "en") {
	await page
		.getByLabel(m.signin_code({}, { locale }), { exact: true })
		.evaluate((element, value) => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			if (!setter) throw new Error("Input setter unavailable");
			setter.call(element, value);
			element.dispatchEvent(new Event("input", { bubbles: true }));
		}, code);
}

test("email code signup moves to a focused code form and establishes a verified session", async ({
	page,
	workspace,
}) => {
	await workspace.enableCodeDelivery(page);
	await page.goto(`${workspace.origin}/login`);
	const email = "otp-browser@example.invalid";
	await page.getByLabel("Email address", { exact: true }).fill(email);
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	const codeInput = page.getByLabel("Sign-in code", { exact: true });
	await expect(codeInput).toBeFocused();
	await expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
	const code = workspace.codes.get(email);
	if (!code) throw new Error("Expected an in-memory code");
	await enterCode(page, code);
	await page
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await dismissPasskeySetup(page);
	await expect(
		page.getByRole("heading", {
			name: "Create your first organization",
			exact: true,
		}),
	).toBeVisible();
});

test("email code resend and change-email actions respect the countdown in both locales", async ({
	page,
	workspace,
}) => {
	await page.clock.install({ time: new Date("2026-11-03T12:00:00Z") });
	let sends = 0;
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
		sends++;
		return route.fulfill({ status: 200, json: { success: true } });
	});
	for (const locale of ["en", "fr"] as const) {
		const options = { locale };
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.setViewportSize({ width: 320, height: 900 });
		await page.goto(`${workspace.origin}/login`);
		await page
			.getByLabel(m.email_address({}, options), { exact: true })
			.fill("first@example.invalid");
		await page
			.getByRole("button", { name: m.send_code({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: m.check_your_email({}, options),
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /60s/ })).toBeDisabled();
		await page.clock.fastForward(61_000);
		const resend = page.getByRole("button", {
			name: m.resend_code({}, options),
			exact: true,
		});
		await expect(resend).toBeEnabled();
		await resend.click();
		await expect(page.getByRole("button", { name: /60s/ })).toBeDisabled();
		await page
			.getByRole("button", { name: m.change_email({}, options), exact: true })
			.click();
		await expect(
			page.getByLabel(m.email_address({}, options), { exact: true }),
		).toHaveValue("first@example.invalid");
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
	expect(sends).toBe(4);
});

test("loading is explicit and retrying does not collapse feedback or change button width", async ({
	page,
	workspace,
}) => {
	let { promise: held, release } = createGate();
	let sends = 0;
	await page.route(
		"**/api/auth/email-otp/send-verification-otp",
		async (route) => {
			sends++;
			await held;
			await route.fulfill({ status: 400, json: { code: "UNAVAILABLE" } });
		},
	);
	await page.goto(`${workspace.origin}/login`);
	const email = page.getByLabel("Email address", { exact: true });
	await email.fill("retry@example.invalid");
	const submit = page.locator('button[type="submit"]');
	const passkey = page.getByRole("button", {
		name: "Sign in with a passkey",
		exact: true,
	});
	const initial = await submit.boundingBox();
	await submit.click();
	await expect(submit).toHaveText(/Sending code/);
	await expect(submit).toHaveAttribute("aria-busy", "true");
	await expect(submit).toHaveCSS("opacity", "1");
	await expect(email).toBeEnabled();
	await expect(email).toHaveAttribute("readonly", "");
	expect((await submit.boundingBox())?.width).toBe(initial?.width);
	release();
	await expect(page.getByRole("alert")).toContainText(
		"We couldn’t request a code",
	);
	const afterError = await passkey.boundingBox();
	({ promise: held, release } = createGate());
	await submit.click();
	await expect(submit).toHaveAttribute("aria-busy", "true");
	expect((await passkey.boundingBox())?.y).toBe(afterError?.y);
	release();
	await expect(page.getByRole("alert")).toContainText(
		"We couldn’t request a code",
	);
	expect(sends).toBe(2);
});

test("wrong codes are clear errors and a lost verification response is not automatically retried", async ({
	page,
	workspace,
}) => {
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
		route.fulfill({ status: 200, json: { success: true } }),
	);
	let verifications = 0;
	await page.route("**/api/auth/sign-in/email-otp", (route) => {
		verifications++;
		return verifications === 1
			? route.fulfill({ status: 400, json: { code: "INVALID_OTP" } })
			: route.abort();
	});
	await page.goto(`${workspace.origin}/login`);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("wrong@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await enterCode(page, "012345");
	await page
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("incorrect or expired");
	await expect(
		page.getByLabel("Sign-in code", { exact: true }),
	).toHaveAttribute("aria-invalid", "true");
	await page
		.getByRole("button", { name: "Verify and continue", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Check sign-in status", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Check sign-in status", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("Request a new code");
	expect(verifications).toBe(2);
});
