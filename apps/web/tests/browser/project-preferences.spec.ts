import type { Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import { eq } from "drizzle-orm";
import { accountContextHeader } from "../../src/auth/account-context";
import {
	projectMember,
	project as projectTable,
	twoFactor,
} from "../../src/db/schema";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { gate } from "../gate";
import { settingsPath } from "../settings-path";
import { authenticatorCode } from "../totp";
import {
	data,
	dismissPasskeySetup,
	expect,
	openInvitationForm,
	test,
} from "./fixtures";

async function emailSignIn(
	page: Page,
	workspace: {
		origin: string;
		enableCodeDelivery: (page: Page) => Promise<void>;
		submitReceivedCode: (page: Page, email: string) => Promise<void>;
	},
	email: string,
) {
	await workspace.enableCodeDelivery(page);
	await page.goto(`${workspace.origin}/login`);
	await page.getByLabel("Email address", { exact: true }).fill(email);
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await workspace.submitReceivedCode(page, email);
	await dismissPasskeySetup(page);
	const session = await (
		await page.request.get(`${workspace.origin}/api/auth/get-session`)
	).json();
	expect(session.user.email).toBe(email);
	return session.user.id as string;
}

for (const locale of ["en", "fr"] as const) {
	test(`project customization and TanStack member tables in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const opt = { locale };
		const owner = await workspace.signIn(
			page,
			"preferences-owner@example.invalid",
		);
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "Preferences",
					slug: "preferences",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projects.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Two VM project",
				}),
			),
		);
		const collaborator = await workspace.signIn(
			page,
			"preferences-member@example.invalid",
		);
		const membership = await workspace.auth.api.addMember({
			body: {
				organizationId: organization.id,
				userId: collaborator.userId,
				role: "member",
			},
		});
		await workspace.signIn(page, "preferences-owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.setViewportSize({ width: 1440, height: 1050 });
		const selection = {
			organizationId: organization.id,
			projectId: project.id,
		};
		await page.goto(
			`${workspace.origin}${settingsPath("project-customization", selection)}`,
		);
		await page
			.getByRole("button", { name: m.project_add_tag({}, opt), exact: true })
			.click();
		await page
			.getByLabel(m.project_tag({}, opt), { exact: true })
			.fill("production");
		await page
			.getByRole("button", { name: m.project_save_tag({}, opt), exact: true })
			.click();
		await expect(
			page.getByRole("button", {
				name: m.project_remove_tag({ tag: "production" }, opt),
				exact: true,
			}),
		).toBeVisible();
		await page
			.getByLabel(m.project_group({}, opt), { exact: true })
			.fill("Production apps");
		await page
			.getByRole("button", { name: m.project_save_group({}, opt), exact: true })
			.click();
		const zone = page.getByRole("combobox", {
			name: m.project_time_zone({}, opt),
			exact: true,
		});
		await zone.click();
		await page
			.getByRole("combobox", {
				name: m.project_search_time_zones({}, opt),
				exact: true,
			})
			.fill("Toronto");
		await page
			.getByRole("option", { name: "America/Toronto", exact: true })
			.click();
		await expect(zone).toContainText("America/Toronto");
		await page
			.getByLabel(m.project_week_start({}, opt), { exact: true })
			.selectOption("1");
		await expect
			.poll(
				async () =>
					(
						await workspace.database.db
							.select()
							.from(projectTable)
							.where(eq(projectTable.id, project.id))
					)[0]?.weekStartsOn,
			)
			.toBe(1);
		await page.reload();
		await expect(
			page.getByLabel(m.project_group({}, opt), { exact: true }),
		).toHaveValue("Production apps");
		await expect(zone).toContainText("America/Toronto");
		await expect(
			page.getByLabel(m.project_week_start({}, opt), { exact: true }),
		).toHaveValue("1");
		const nav = page.getByRole("navigation", {
			name: m.settings_navigation({}, opt),
			exact: true,
		});
		await expect(nav.getByRole("link").locator("svg")).toHaveCount(0);
		await page.goto(
			`${workspace.origin}${settingsPath("project-members", selection)}`,
		);
		await expect(
			page.getByRole("combobox", {
				name: m.project_default_access({}, opt),
				exact: true,
			}),
		).toBeDisabled();
		await page
			.getByRole("button", { name: m.project_add_member({}, opt), exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: m.project_add_member({}, opt),
			exact: true,
		});
		await dialog
			.getByLabel(m.project_select_member({}, opt), { exact: true })
			.selectOption(membership.id);
		await dialog
			.getByLabel(
				m.project_role_for(
					{ email: "preferences-member@example.invalid" },
					opt,
				),
				{ exact: true },
			)
			.selectOption("member");
		await dialog
			.getByRole("button", {
				name: m.save_grant_for(
					{ email: "preferences-member@example.invalid" },
					opt,
				),
				exact: true,
			})
			.click();
		await expect(dialog).toHaveCount(0);
		const table = page.getByRole("table", {
			name: m.project_members({}, opt),
			exact: true,
		});
		await expect(
			table.getByText("preferences-member@example.invalid", { exact: true }),
		).toBeVisible();
		await table
			.getByLabel(
				m.project_role_for(
					{ email: "preferences-member@example.invalid" },
					opt,
				),
				{ exact: true },
			)
			.selectOption("viewer");
		await table
			.getByRole("button", {
				name: m.save_grant_for(
					{ email: "preferences-member@example.invalid" },
					opt,
				),
				exact: true,
			})
			.click();
		await expect
			.poll(
				async () =>
					(
						await workspace.database.db
							.select()
							.from(projectMember)
							.where(eq(projectMember.memberId, membership.id))
					)[0]?.role,
			)
			.toBe("viewer");
		await page.goto(
			`${workspace.origin}${settingsPath("organization-members", selection)}`,
		);
		const members = page.getByRole("table", {
			name: m.organization_members({}, opt),
			exact: true,
		});
		for (const label of [
			m.member_project_access({}, opt),
			m.member_two_factor({}, opt),
			m.settings_joined({}, opt),
			m.member_last_sign_in({}, opt),
		])
			await expect(
				members.getByRole("columnheader", { name: new RegExp(label) }),
			).toBeVisible();
		await page
			.getByRole("searchbox", {
				name: m.settings_search_members({}, opt),
				exact: true,
			})
			.fill("preferences-member");
		await expect(members.getByRole("row")).toHaveCount(2);
		await expect(
			members.getByText("Two VM project", { exact: true }),
		).toBeVisible();
		await page
			.getByRole("searchbox", {
				name: m.settings_search_members({}, opt),
				exact: true,
			})
			.fill("");
		await openInvitationForm(page, locale);
		await page
			.getByLabel(m.email_address({}, opt), { exact: true })
			.fill("invited-preferences@example.invalid");
		await page
			.getByRole("button", {
				name: m.invite_team_members({}, opt),
				exact: true,
			})
			.click();
		const invites = page.getByRole("table", {
			name: m.invitations({}, opt),
			exact: true,
		});
		await expect(
			invites.getByText("invited-preferences@example.invalid", { exact: true }),
		).toBeVisible();
		await expect(
			invites.getByText(m.you_label({}, opt), { exact: true }),
		).toBeVisible();
		await expect(invites.getByRole("link")).toHaveAttribute(
			"href",
			/\/invitations\//,
		);
		await invites
			.getByRole("button", {
				name: m.settings_sort_by(
					{ column: m.invitation_created({}, opt) },
					opt,
				),
				exact: true,
			})
			.click();
		await expect(
			invites
				.getByRole("columnheader", {
					name: new RegExp(m.invitation_created({}, opt)),
				})
				.last(),
		).toHaveAttribute("aria-sort", /ascending|descending/);
	});
}

test("authenticator enrollment gates email login while user-verified passkeys remain direct", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => false },
		);
	});
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
		const email = "authenticator@example.invalid";
		await workspace.signIn(page, email);
		await page.goto(`${workspace.origin}${settingsPath("user")}`);
		const setupResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/auth/two-factor/enable",
		);
		await page
			.getByRole("button", {
				name: "Set up two-factor authentication",
				exact: true,
			})
			.click();
		const response = await setupResponse;
		expect(response.status()).toBe(200);
		const setup = await response.json();
		const dialog = page.getByRole("dialog", {
			name: "Set up two-factor authentication",
			exact: true,
		});
		await expect(
			dialog.getByRole("img", {
				name: "Authenticator setup QR code",
				exact: true,
			}),
		).toBeVisible();
		await expect(dialog.getByText(setup.backupCodes[0])).toHaveCount(0);
		await dialog
			.getByLabel("Authenticator code", { exact: true })
			.fill(authenticatorCode(setup.totpURI));
		await dialog
			.getByRole("button", { name: "Verify and enable 2FA", exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText("2FA enabled", { exact: true })).toBeVisible();
		await page
			.getByRole("button", { name: "Recovery codes", exact: true })
			.click();
		const recovery = page.getByRole("dialog", {
			name: "Recovery codes",
			exact: true,
		});
		await expect(recovery.getByRole("listitem")).toHaveCount(0);
		await recovery
			.getByRole("button", { name: "Generate recovery codes", exact: true })
			.click();
		await expect(recovery.getByRole("listitem")).toHaveCount(10);
		await expect(recovery.getByText(setup.backupCodes[0])).toHaveCount(0);
		await recovery.getByRole("button", { name: "Close" }).click();
		await expect(recovery).toHaveCount(0);
		await expect(page.getByText("2FA enabled", { exact: true })).toBeVisible();
		await page
			.getByLabel("Passkey name", { exact: true })
			.fill("Verified device");
		await page
			.getByRole("button", { name: "Add a passkey", exact: true })
			.click();
		await expect(
			page.getByRole("cell", { name: "Verified device", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await workspace.enableCodeDelivery(page);
		await page.goto(
			`${workspace.origin}/login?redirect=${encodeURIComponent(settingsPath("user"))}`,
		);
		await page.getByLabel("Email address", { exact: true }).fill(email);
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await workspace.submitReceivedCode(page, email);
		await expect(
			page.getByRole("heading", { name: "Verify your sign-in", exact: true }),
		).toBeVisible();
		expect(
			await (
				await page.request.get(`${workspace.origin}/api/auth/get-session`)
			).json(),
		).toBeNull();
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Verify your sign-in", exact: true }),
		).toBeVisible();
		await page
			.getByLabel("Authenticator code", { exact: true })
			.fill(authenticatorCode(setup.totpURI));
		await page
			.getByRole("button", { name: "Verify and sign in", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Profile", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await cdp.send("WebAuthn.setUserVerified", {
			authenticatorId,
			isUserVerified: false,
		});
		const denied = await page.evaluate(async () => {
			const options = await (
				await fetch("/api/auth/passkey/generate-authenticate-options")
			).json();
			const credential = await navigator.credentials.get({
				publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({
					...options,
					userVerification: "discouraged",
				}),
			});
			if (!(credential instanceof PublicKeyCredential))
				throw new Error("Expected virtual assertion");
			const { clientExtensionResults: _, ...response } = credential.toJSON();
			return (
				await fetch("/api/auth/passkey/verify-authentication", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ response }),
				})
			).status;
		});
		expect(denied).toBeGreaterThanOrEqual(400);
		expect(
			await (
				await page.request.get(`${workspace.origin}/api/auth/get-session`)
			).json(),
		).toBeNull();
		await cdp.send("WebAuthn.setUserVerified", {
			authenticatorId,
			isUserVerified: true,
		});
		await page
			.getByRole("button", { name: "Sign in with a passkey", exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: "Create your first organization",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Verify your sign-in", exact: true }),
		).toHaveCount(0);
	} finally {
		await cdp
			.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
			.catch(() => {});
		await cdp.detach().catch(() => {});
	}
});

test("account switches retire factor secrets and reject stale-tab management", async ({
	page,
	workspace,
}) => {
	const first = await workspace.signIn(page, "factor-first@example.invalid");
	await page.goto(`${workspace.origin}${settingsPath("user")}`);
	await page
		.getByRole("button", {
			name: "Set up two-factor authentication",
			exact: true,
		})
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Set up two-factor authentication",
		exact: true,
	});
	await expect(
		dialog.getByText(
			"If you can’t scan the QR code, enter this setup key in your authenticator app instead.",
			{ exact: true },
		),
	).toBeVisible();
	const secondPage = await page.context().newPage();
	const sessionGate = gate();
	const sessionStarted = gate();
	try {
		await page.route("**/api/auth/get-session**", async (route) => {
			sessionStarted.release();
			await sessionGate.promise;
			await route.continue().catch(() => {});
		});
		const secondUserId = await emailSignIn(
			secondPage,
			workspace,
			"factor-second@example.invalid",
		);
		const denied = await page.request.post(
			`${workspace.origin}/api/auth/two-factor/enable`,
			{
				data: { method: "totp" },
				headers: {
					origin: workspace.origin,
					[accountContextHeader]: first.userId,
				},
			},
		);
		expect(denied.status()).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "ACCOUNT_CHANGED" });
		expect(
			await workspace.database.db
				.select()
				.from(twoFactor)
				.where(eq(twoFactor.userId, secondUserId)),
		).toHaveLength(0);
		await sessionStarted.promise;
		await expect(dialog).toHaveCount(0);
		sessionGate.release();
		await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
			"factor-second@example.invalid",
		);
	} finally {
		sessionGate.release();
		await secondPage.close();
	}
});

test("a delayed enrollment response cannot restore secrets after a cross-tab account change", async ({
	page,
	workspace,
}) => {
	await workspace.signIn(page, "delayed-factor-first@example.invalid");
	await page.goto(`${workspace.origin}${settingsPath("user")}`);
	const issued = gate();
	const responseGate = gate();
	const delivered = gate();
	const sessionGate = gate();
	const sessionStarted = gate();
	let status = 0;
	await page.route("**/api/auth/two-factor/enable", async (route) => {
		const response = await route.fetch();
		status = response.status();
		issued.release();
		await responseGate.promise;
		await route.fulfill({ response }).catch(() => {});
		delivered.release();
	});
	const secondPage = await page.context().newPage();
	try {
		await page
			.getByRole("button", {
				name: "Set up two-factor authentication",
				exact: true,
			})
			.click();
		await issued.promise;
		expect(status).toBe(200);
		await page.route("**/api/auth/get-session**", async (route) => {
			sessionStarted.release();
			await sessionGate.promise;
			await route.continue().catch(() => {});
		});
		await emailSignIn(
			secondPage,
			workspace,
			"delayed-factor-second@example.invalid",
		);
		await sessionStarted.promise;
		responseGate.release();
		await delivered.promise;
		await expect(
			page.getByRole("dialog", {
				name: "Set up two-factor authentication",
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			page.getByText(
				"If you can’t scan the QR code, enter this setup key in your authenticator app instead.",
				{ exact: true },
			),
		).toHaveCount(0);
		sessionGate.release();
		await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
			"delayed-factor-second@example.invalid",
		);
	} finally {
		responseGate.release();
		sessionGate.release();
		await secondPage.close();
	}
});
