import { m } from "@recount/i18n/messages";
import { expect, notices, settingsUrl, test } from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`profile email links show request, invalid and success states in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const oldEmail = `profile-${locale}@example.invalid`;
		const newEmail = `replacement-${locale}@example.invalid`;
		const account = await workspace.signIn(page, oldEmail);
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.route("**/api/auth/change-email", async (route) => {
			const incoming = route.request();
			const response = await workspace.auth.handler(
				new Request(incoming.url(), {
					method: "POST",
					headers: await incoming.allHeaders(),
					body: incoming.postData(),
				}),
			);
			await workspace.auth.emailDelivery.drain();
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
			});
		});
		await page.goto(settingsUrl(workspace.origin, "user"));
		const options = { locale };
		await page
			.getByRole("button", {
				name: m.profile_email_change_title({}, options),
				exact: true,
			})
			.click();
		const dialog = page.getByRole("dialog", {
			name: m.profile_email_change_title({}, options),
			exact: true,
		});
		await expect(dialog).toHaveCSS("top", "32px");
		await dialog
			.getByLabel(m.profile_email_change_new({}, options), { exact: true })
			.fill(newEmail);
		await dialog
			.getByRole("button", {
				name: m.profile_email_change_send({}, options),
				exact: true,
			})
			.click();
		await expect(dialog.getByRole("status")).toHaveText(
			m.profile_email_change_received({ email: newEmail }, options),
		);
		await expect(page.locator("#profile-email")).toHaveValue(oldEmail);
		const message = workspace.profileEmails
			.filter((entry) => entry.kind === "verification")
			.at(-1);
		if (!message) throw new Error("Expected verification email");
		expect(message.locale).toBe(locale);
		const invalid = new URL(message.url);
		invalid.searchParams.set("token", "invalid");
		await page.goto(invalid.href);
		const confirm = () =>
			page.getByRole("button", {
				name: m.profile_email_change_confirm({}, options),
				exact: true,
			});
		await confirm().click();
		await expect(page.getByRole("alert")).toHaveText(
			m.profile_email_change_invalid({}, options),
		);
		await page.goto(message.url);
		await expect(confirm()).toBeVisible();
		expect(
			(await workspace.auth.api.getSession({ headers: account.headers }))?.user
				.email,
		).toBe(oldEmail);
		await confirm().click();
		await expect(
			notices(page).filter({
				hasText: m.profile_email_change_saved({}, options),
			}),
		).toBeVisible();
		await page
			.getByRole("link", {
				name: m.profile_email_change_review_security({}, options),
				exact: true,
			})
			.click();
		await expect(page.locator("#profile-email")).toHaveValue(newEmail);
	});
}
