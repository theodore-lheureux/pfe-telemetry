import type { Locale } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { and, eq } from "drizzle-orm";
import { invitation, member } from "../../src/db/schema";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import { gate as createGate } from "../gate";
import {
	closePreferences,
	data,
	editMemberRole,
	expect,
	openInvitationForm,
	openMemberActions,
	openPreferences,
	openProjectGrant,
	openSettingsSection,
	settingsUrl,
	test,
} from "./fixtures";

test.use({ timezoneId: "America/Toronto" });

test("localized SSR, invalid preferences, concurrent requests, hydration and confirmed persistence", async ({
	page,
	workspace,
}) => {
	const responses = await Promise.all(
		Array.from({ length: 12 }, async (_, index) => {
			const locale = index % 2 ? "fr" : "en";
			const response = await fetch(`${workspace.origin}/login`, {
				headers: { cookie: `recount_locale=${locale}` },
			});
			const html = await response.text();
			expect(html).toContain(`<html lang="${locale}"`);
			expect(html).toContain(
				locale === "fr"
					? "Se connecter avec une clé d’accès"
					: "Sign in with a passkey",
			);
			expect(response.headers.get("cache-control")).toContain("no-store");
			expect(response.headers.get("vary")).toContain("Cookie");
			return response.status;
		}),
	);
	expect(responses.every((status) => status === 200)).toBe(true);
	for (const value of ["invalid", "FR"]) {
		const response = await fetch(`${workspace.origin}/login`, {
			headers: { cookie: `recount_locale=${value}` },
		});
		expect(await response.text()).toContain(
			`<html lang="${value === "FR" ? "fr" : "en"}"`,
		);
	}
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/hydration|did not match/i.test(message.text()))
			errors.push(message.text());
	});
	await page.goto(
		`${workspace.origin}/login?redirect=%2Finvitations%2Freturn-id#keep`,
	);
	await page.getByLabel("Email address").fill("unsaved@example.invalid");
	await page.getByLabel("Language", { exact: true }).selectOption("fr");
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("Email address")).toHaveValue(
		"unsaved@example.invalid",
	);
	expect(
		(await page.context().cookies()).find(
			(cookie) => cookie.name === "recount_locale",
		)?.value ?? "en",
	).toBe("en");
	await page.getByLabel("Language", { exact: true }).selectOption("fr");
	await page
		.getByRole("button", { name: "Change language", exact: true })
		.click();
	await expect(page.locator("html")).toHaveAttribute("lang", "fr");
	await expect(
		page.getByRole("heading", { name: "Se connecter", exact: true }),
	).toBeVisible();
	expect(new URL(page.url()).searchParams.get("redirect")).toBe(
		"/invitations/return-id",
	);
	expect(new URL(page.url()).hash).toBe("#keep");
	const cookie = (await page.context().cookies()).find(
		(entry) => entry.name === "recount_locale",
	);
	expect(cookie).toMatchObject({ value: "fr", path: "/", sameSite: "Lax" });
	expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 30_000_000);
	await page.getByRole("button", { name: "Continuer par e-mail" }).click();
	expect(
		await page
			.getByLabel("Adresse e-mail")
			.evaluate((element: HTMLInputElement) => element.validationMessage),
	).toBe("Renseignez ce champ.");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("lang", "fr");
	const missing = await page.goto(`${workspace.origin}/not-a-page`);
	expect(missing?.status()).toBe(404);
	await expect(
		page.getByRole("heading", { name: "Page introuvable" }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

for (const locale of ["en", "fr"] as const) {
	test(`failed owner confirmation remains open and blocks locale switching while pending in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Owner safety",
					slug: "owner-safety",
				}),
			),
		);
		const replacement = await workspace.signIn(
			page,
			"replacement@example.invalid",
		);
		const replacementMember = await workspace.auth.api.addMember({
			body: {
				organizationId: organization.id,
				userId: replacement.userId,
				role: "owner",
			},
		});
		await workspace.signIn(page, "owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(
			settingsUrl(
				`${workspace.origin}/organizations/${organization.id}`,
				"organization-members",
			),
		);
		const options = { locale };
		await openMemberActions(page, "owner@example.invalid", locale);
		const leave = page.getByRole("menuitem", {
			name: m.leave_member_named({ email: "owner@example.invalid" }, options),
			exact: true,
		});
		await leave.click();
		const dialog = page.getByRole("alertdialog");
		await expect(
			dialog.getByRole("button", { name: m.keep_membership({}, options) }),
		).toBeFocused();
		data(
			await workspace.operations(owner.headers, (actor) =>
				memberDomain.updateRole(
					workspace.database.db,
					workspace.auth,
					owner.headers,
					actor,
					{
						organizationId: organization.id,
						memberId: replacementMember.id,
						role: "member",
					},
				),
			),
		);
		const { promise: received, release: ready } = createGate();
		const { promise: gate, release } = createGate();
		await page.route("**/_serverFn/**", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			const response = await route.fetch();
			ready();
			await gate;
			await route.fulfill({ response });
		});
		await dialog
			.getByRole("button", { name: m.confirm_leave({}, options), exact: true })
			.click();
		await received;
		// The modal confirmation makes settings inaccessible while the write is pending.
		await expect(
			page.getByRole("button", { name: m.settings({}, options), exact: true }),
		).toHaveCount(0);
		await expect(
			dialog.getByRole("button", {
				name: m.saving({}, options),
				exact: true,
			}),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		release();
		await expect(dialog.getByRole("alert")).toContainText(
			locale === "fr" ? "conserver un propriétaire" : "retain an owner",
		);
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", {
				name: m.settings_member_actions(
					{ email: "owner@example.invalid" },
					options,
				),
				exact: true,
			}),
		).toBeFocused();
		await openPreferences(page, locale);
		await expect(
			page.getByLabel(m.language({}, options), { exact: true }),
		).toBeEnabled();
		await closePreferences(page);
	});
	test(`all application features render and mutate in ${locale}`, async ({
		page,
		browser,
		workspace,
	}) => {
		test.setTimeout(90_000);
		const options = { locale };
		const text = (
			message: (
				inputs?: Record<never, never>,
				options?: { locale?: Locale },
			) => string,
		) => message({}, options);
		const owner = await workspace.signIn(page, "owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		const errors: string[] = [];
		let mutationURL = "";
		page.on("request", (request) => {
			if (
				!mutationURL &&
				request.method() === "POST" &&
				request.url().includes("/_serverFn/")
			)
				mutationURL = request.url();
		});
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (/hydration|did not match/i.test(message.text()))
				errors.push(message.text());
		});
		await page.goto(workspace.origin);
		await expect(
			page.getByRole("heading", {
				name: text(m.create_your_first_organization),
			}),
		).toBeVisible();
		await page
			.getByRole("link", { name: text(m.create_organization), exact: true })
			.click();
		await page.getByLabel(text(m.name), { exact: true }).fill("Locale lab");
		await page
			.getByRole("button", { name: text(m.create_organization), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Locale lab", exact: true }),
		).toBeVisible();
		const orgURL = page.url().replace(/\/$/, "");
		const organizationId = orgURL.split("/").at(-1) ?? "";
		const csrf = await fetch(mutationURL, {
			method: "POST",
			headers: {
				origin: "https://attacker.example.invalid",
				"sec-fetch-site": "cross-site",
				"content-type": "application/json",
				cookie: owner.headers.get("cookie") ?? "",
			},
			body: JSON.stringify({
				data: { name: "Cross-site attempt", slug: "cross-site-attempt" },
			}),
		});
		expect(csrf.status).toBe(403);
		expect(
			data(
				await workspace.operations(owner.headers, (actor) =>
					organizationDomain.listOrganizations(workspace.database.db, actor),
				),
			).map((organization) => organization.name),
		).toEqual(["Locale lab"]);
		await openSettingsSection(page, text(m.organization_settings), locale);
		await openSettingsSection(page, text(m.members), locale);
		await expect(
			page.getByText(text(m.role_owner), { exact: true }),
		).toBeVisible();
		await page.goto(orgURL);
		await page
			.getByRole("link", { name: text(m.create_project), exact: true })
			.click();
		await page.getByLabel(text(m.name), { exact: true }).fill("Locale project");
		await page
			.getByRole("button", { name: text(m.create_project), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: text(m.executions), exact: true }),
		).toBeVisible();
		const projectURL = page.url().replace(/\/executions\/?$/, "");
		await openSettingsSection(page, text(m.project_settings), locale);
		await openSettingsSection(page, text(m.settings_customization), locale);
		await page.getByLabel(text(m.name), { exact: true }).fill("   ");
		await page
			.getByRole("button", { name: text(m.save_project), exact: true })
			.click();
		await expect(
			page.getByLabel(text(m.name), { exact: true }),
		).toHaveAttribute("aria-invalid", "true");
		await expect(page.locator("#entity-name-error")).toHaveText(
			text(m.enter_a_name_not_just_spaces),
		);
		await page
			.getByLabel(text(m.name), { exact: true })
			.fill("Locale project renamed");
		await page
			.getByRole("button", { name: text(m.save_project), exact: true })
			.click();
		await expect(
			page.getByText(text(m.changes_saved), { exact: true }),
		).toBeVisible();

		const otherContext = await browser.newContext();
		try {
			const otherPage = await otherContext.newPage();
			const collaborator = await workspace.signIn(
				otherPage,
				"collaborator@example.invalid",
			);
			const collaboratorMember = await workspace.auth.api.addMember({
				body: { organizationId, userId: collaborator.userId, role: "member" },
			});
			await page.goto(settingsUrl(orgURL, "organization-members"));
			await editMemberRole(page, "collaborator@example.invalid", locale);
			const role = page.getByLabel(
				m.role_for({ email: "collaborator@example.invalid" }, options),
				{ exact: true },
			);
			await expect(role).toHaveValue("member");
			await role.focus();
			await page.keyboard.press("ArrowUp");
			await page.keyboard.press("ArrowDown");
			await role.selectOption("admin");
			await page
				.getByRole("button", {
					name: m.save_role_for(
						{ email: "collaborator@example.invalid" },
						options,
					),
					exact: true,
				})
				.click();
			await expect(
				page.getByText(text(m.member_role_updated), { exact: true }),
			).toBeVisible();
			await workspace.operations(owner.headers, (actor) =>
				memberDomain.updateRole(
					workspace.database.db,
					workspace.auth,
					owner.headers,
					actor,
					{
						organizationId,
						memberId: collaboratorMember.id,
						role: "member",
					},
				),
			);
			await page.goto(settingsUrl(projectURL, "project-members"));
			await openProjectGrant(page, "collaborator@example.invalid", locale);
			await page
				.getByLabel(
					m.project_role_for(
						{ email: "collaborator@example.invalid" },
						options,
					),
					{ exact: true },
				)
				.selectOption("viewer");
			await page
				.getByRole("button", {
					name: m.save_grant_for(
						{ email: "collaborator@example.invalid" },
						options,
					),
					exact: true,
				})
				.click();
			await expect(
				page.getByText(text(m.project_grant_saved), { exact: true }),
			).toBeVisible();
			const removeGrant = page.getByRole("button", {
				name: m.remove_grant_named(
					{ email: "collaborator@example.invalid" },
					options,
				),
				exact: true,
			});
			await removeGrant.click();
			await expect(
				page.getByRole("button", { name: text(m.keep_current_access) }),
			).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(removeGrant).toBeFocused();
			await page.goto(settingsUrl(orgURL, "organization-members"));
			await openInvitationForm(page, locale);
			await page
				.getByLabel(text(m.email_address), { exact: true })
				.fill("recipient@example.invalid");
			await page
				.getByLabel(text(m.organization_role), { exact: true })
				.selectOption("member");
			await page
				.getByRole("button", { name: text(m.invite_team_members), exact: true })
				.click();
			await expect(
				page.getByText(
					text(m.invitation_created_ask_the_recipient_to_check_their),
					{ exact: true },
				),
			).toBeVisible();
			const [created] = await workspace.database.db
				.select()
				.from(invitation)
				.where(
					and(
						eq(invitation.organizationId, organizationId),
						eq(invitation.email, "recipient@example.invalid"),
					),
				);
			await page
				.getByRole("button", {
					name: m.resend_invitation_named(
						{ email: "recipient@example.invalid" },
						options,
					),
					exact: true,
				})
				.click();
			await expect(
				page.getByText(
					text(m.invitation_delivery_requested_again_ask_the_recipient_to),
					{ exact: true },
				),
			).toBeVisible();
			await page.reload();
			await expect(
				page.getByText("recipient@example.invalid", { exact: true }),
			).toBeVisible();
			await page
				.getByRole("button", {
					name: m.cancel_invitation_named(
						{ email: "recipient@example.invalid" },
						options,
					),
					exact: true,
				})
				.click();
			await expect(page.getByRole("alertdialog")).toContainText(
				text(m.cancel_this_invitation_its_link_will_no_longer),
			);
			await page.keyboard.press("Escape");
			await otherContext.clearCookies();
			await otherContext.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
			await otherPage.goto(`${workspace.origin}/invitations/${created.id}`);
			await expect(otherPage).toHaveURL(/\/login\?redirect=/);
			expect(new URL(otherPage.url()).searchParams.get("redirect")).toBe(
				`/invitations/${created.id}`,
			);
			const recipient = await workspace.signIn(
				otherPage,
				"recipient@example.invalid",
			);
			await otherContext.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
			await otherPage.goto(`${workspace.origin}/invitations/${created.id}`);
			await expect(
				otherPage.getByRole("button", { name: text(m.accept_invitation) }),
			).toBeVisible();
			expect(
				await workspace.database.db
					.select()
					.from(member)
					.where(eq(member.userId, recipient.userId)),
			).toHaveLength(0);
			await otherPage
				.getByRole("button", { name: text(m.reject_invitation) })
				.click();
			await expect(otherPage.getByRole("alertdialog")).toBeVisible();
			await otherPage.keyboard.press("Escape");
			await otherPage
				.getByRole("button", { name: text(m.accept_invitation) })
				.click();
			await expect(
				otherPage.getByRole("heading", { name: "Locale lab", exact: true }),
			).toBeVisible();
			expect(
				(
					await workspace.database.db
						.select()
						.from(invitation)
						.where(eq(invitation.id, created.id))
				)[0].status,
			).toBe("accepted");
		} finally {
			await otherContext.close();
		}

		await page.goto(settingsUrl(projectURL, "collectors"));
		await expect(
			page.getByRole("heading", { name: text(m.collectors), level: 1 }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: text(m.enrollment_key_create),
				exact: true,
			})
			.click();
		const create = page.getByRole("dialog", {
			name: text(m.enrollment_key_create),
		});
		await create.getByLabel(text(m.name), { exact: true }).fill("Locale key");
		await create
			.getByRole("button", {
				name: text(m.enrollment_key_create),
				exact: true,
			})
			.click();
		const reveal = page.getByRole("dialog", {
			name: text(m.enrollment_key_created_title),
		});
		const secret = (await reveal.locator("code").first().textContent()) ?? "";
		expect(secret).toMatch(/^recount_enroll_/);
		await reveal
			.getByRole("button", { name: text(m.done), exact: true })
			.click();
		await expect(reveal).toHaveCount(0);
		expect((await page.content()).includes(secret)).toBe(false);
		const collectorsSSR = await page.reload();
		expect((await collectorsSSR?.text())?.includes(secret)).toBe(false);
		await expect(page.getByText("Locale key", { exact: true })).toBeVisible();
		await page.goto(settingsUrl(workspace.origin, "user"));
		await expect(
			page.getByRole("heading", {
				name: text(m.user_profile),
				exact: true,
			}),
		).toBeVisible();
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
		await page
			.getByLabel(text(m.passkey_name), { exact: true })
			.fill("Test device");
		await page
			.getByRole("button", { name: text(m.add_a_passkey), exact: true })
			.click();
		await expect(page.getByText("Test device", { exact: true })).toBeVisible();
		await page
			.getByRole("button", { name: text(m.remove), exact: true })
			.click();
		await expect(page.getByRole("alertdialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: text(m.remove), exact: true }),
		).toBeFocused();
		const { promise: listRequested, release: listReady } = createGate();
		const { promise: listGate, release: releaseList } = createGate();
		await page.route(
			"**/api/auth/passkey/list-user-passkeys**",
			async (route) => {
				await route.fetch();
				listReady();
				await listGate;
				await route.abort("failed");
			},
		);
		await page
			.getByRole("button", { name: text(m.remove), exact: true })
			.click();
		await page
			.getByRole("button", { name: text(m.confirm_removal), exact: true })
			.click();
		await listRequested;
		await expect(
			page.getByRole("heading", {
				name: text(m.user_profile),
				exact: true,
			}),
		).toBeFocused();
		releaseList();
		await expect(page.getByRole("alert")).toContainText(
			text(m.could_not_load_passkeys_try_refreshing_the_page),
		);
		await expect(
			page.getByRole("heading", {
				name: text(m.user_profile),
				exact: true,
			}),
		).toBeFocused();
		await page.unroute("**/api/auth/passkey/list-user-passkeys**");
		await page.reload();
		await expect(
			page.getByText(text(m.no_passkeys_registered_yet), { exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: text(m.sign_out), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: text(m.sign_in), exact: true }),
		).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("lang", locale);
		expect((await page.content()).includes(secret)).toBe(false);
		expect(errors).toEqual([]);
	});
}
