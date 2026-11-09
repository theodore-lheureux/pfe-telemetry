import { m } from "@recount/i18n/messages";
import { eq } from "drizzle-orm";
import { settingsPath } from "../../src/components/settings-links";
import {
	member as memberTable,
	organization as organizationTable,
} from "../../src/db/schema";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`scoped settings pages, membership tables and planned authentication in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const owner = await workspace.signIn(
			page,
			"settings-owner@example.invalid",
		);
		const org = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Settings org",
					slug: "settings-org",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: org.id,
					name: "Telemetry project",
					slug: "telemetry-project",
				}),
			),
		);
		const collaborator = await workspace.signIn(
			page,
			"settings-member@example.invalid",
		);
		const membership = await workspace.auth.api.addMember({
			body: {
				organizationId: org.id,
				userId: collaborator.userId,
				role: "member",
			},
		});
		await workspace.signIn(page, "settings-owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.setViewportSize({ width: 1440, height: 1000 });
		const selection = { organizationId: org.id, projectId: project.id };
		await page.goto(
			`${workspace.origin}${settingsPath("organization", selection)}`,
		);
		const name = page.getByLabel(m.name({}, options), { exact: true });
		await expect(
			page.getByRole("button", { name: m.save_name({}, options), exact: true }),
		).toBeDisabled();
		await name.fill("Renamed settings org");
		await page
			.getByRole("button", { name: m.save_name({}, options), exact: true })
			.click();
		await expect(name).toHaveValue("Renamed settings org");
		await expect
			.poll(
				async () =>
					(
						await workspace.database.db
							.select()
							.from(organizationTable)
							.where(eq(organizationTable.id, org.id))
					)[0]?.name,
			)
			.toBe("Renamed settings org");
		const nav = page.getByRole("navigation", {
			name: m.settings_navigation({}, options),
			exact: true,
		});
		await nav
			.getByRole("link", {
				name: m.settings_customization({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: m.settings_page(
					{ page: m.settings_customization({}, options) },
					options,
				),
				exact: true,
			}),
		).toBeVisible();
		await page
			.getByLabel(m.name({}, options), { exact: true })
			.fill("Renamed telemetry project");
		await page
			.getByRole("button", { name: m.save_project({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("button", {
				name: m.save_project({}, options),
				exact: true,
			}),
		).toBeDisabled();
		await nav
			.getByRole("link", { name: m.members({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: m.settings_page({ page: m.members({}, options) }, options),
				exact: true,
			}),
		).toBeVisible();
		const invites = page.getByRole("table", {
			name: m.invitations({}, options),
			exact: true,
		});
		const members = page.getByRole("table", {
			name: m.organization_members({}, options),
			exact: true,
		});
		await expect(invites).toContainText(m.no_invitations({}, options));
		expect(
			await invites.evaluate((element) => element.getBoundingClientRect().top),
		).toBeLessThan(
			await members.evaluate((element) => element.getBoundingClientRect().top),
		);
		await page
			.getByRole("button", {
				name: m.settings_invite_member({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByLabel(m.email_address({}, options), { exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: m.settings_invite_member({}, options),
				exact: true,
			})
			.click();
		const search = page.getByRole("searchbox", {
			name: m.settings_search_members({}, options),
			exact: true,
		});
		await search.fill("settings-member");
		await expect(members.getByRole("row")).toHaveCount(2);
		await page
			.getByRole("button", {
				name: m.settings_member_actions(
					{ email: "settings-member@example.invalid" },
					options,
				),
				exact: true,
			})
			.click();
		await page
			.getByRole("menuitem", {
				name: m.settings_change_role({}, options),
				exact: true,
			})
			.click();
		const role = page.getByLabel(
			m.role_for({ email: "settings-member@example.invalid" }, options),
			{ exact: true },
		);
		await role.selectOption("admin");
		await page
			.getByRole("button", {
				name: m.save_role_for(
					{ email: "settings-member@example.invalid" },
					options,
				),
				exact: true,
			})
			.click();
		await expect(role).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(
						await workspace.database.db
							.select()
							.from(memberTable)
							.where(eq(memberTable.id, membership.id))
					)[0]?.role,
			)
			.toBe("admin");
		await search.fill("");
		const heights = await members
			.locator("tbody tr")
			.evaluateAll((rows) =>
				rows.map((row) => row.getBoundingClientRect().height),
			);
		expect(new Set(heights).size).toBe(1);
		const download = page.waitForEvent("download");
		await page
			.getByRole("button", {
				name: m.settings_download_members({}, options),
				exact: true,
			})
			.click();
		expect((await download).suggestedFilename()).toBe("recount-members.csv");
		await nav
			.getByRole("link", {
				name: m.settings_authentication({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByText(m.settings_coming_soon({}, options), { exact: true }),
		).toHaveCount(6);
		await expect(page.getByRole("switch")).toHaveCount(0);
		await nav
			.getByRole("combobox", {
				name: m.search_settings({}, options),
				exact: true,
			})
			.fill("SAML");
		await nav
			.getByRole("option", { name: m.settings_saml({}, options), exact: true })
			.click();
		await expect(page.locator("#saml-configuration")).toBeVisible();
		expect(new URL(page.url()).searchParams.get("projectId")).toBe(project.id);
		await nav
			.getByRole("link", {
				name: m.settings_delete_organization({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("button", {
				name: m.settings_action_named(
					{
						action: m.settings_delete_organization({}, options),
						name: "Renamed settings org",
					},
					options,
				),
				exact: true,
			}),
		).toBeDisabled();
		await expect(
			page.getByRole("link", {
				name: m.settings_view_ticket({ ticket: "PFE-72" }, options),
				exact: true,
			}),
		).toBeVisible();
		await nav
			.getByRole("link", {
				name: m.settings_danger_zone({}, options),
				exact: true,
			})
			.click();
		await expect(page.locator("#delete-project")).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: m.settings_action_named(
					{
						action: m.settings_delete_project({}, options),
						name: "Renamed telemetry project",
					},
					options,
				),
				exact: true,
			}),
		).toBeDisabled();
		await workspace.signIn(page, "settings-member@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await workspace.database.db
			.update(memberTable)
			.set({ role: "member" })
			.where(eq(memberTable.id, membership.id));
		await page.goto(
			`${workspace.origin}${settingsPath("organization", { organizationId: org.id })}`,
		);
		await expect(
			page.getByLabel(m.name({}, options), { exact: true }),
		).toBeDisabled();
		const denied = await workspace.operations(collaborator.headers, (actor) =>
			organizationDomain.updateOrganization(
				workspace.database.db,
				workspace.auth,
				collaborator.headers,
				actor,
				{ organizationId: org.id, name: "Forbidden" },
			),
		);
		expect(denied.error?.code).toBe("FORBIDDEN");
	});
}
