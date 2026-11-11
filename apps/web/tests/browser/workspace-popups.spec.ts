import { m } from "@recount/i18n/messages";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { workspaceCookieName } from "../../src/organizations/workspace-preference";
import {
	chooseOrganization,
	chooseProject,
	data,
	expect,
	openWorkspaceMenu,
	test,
} from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`workspace selectors keep project context and open shared creation and invitation popups in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const owner = await workspace.signIn(
			page,
			"workspace-popups@example.invalid",
		);
		const first = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "First workspace",
					slug: "first-workspace",
				}),
			),
		);
		const second = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "Second workspace",
					slug: "second-workspace",
				}),
			),
		);
		const makeProject = (organizationId: string, name: string) =>
			workspace
				.operations(owner.headers, (actor) =>
					projects.createProject(workspace.database.db, actor, {
						organizationId,
						name,
						requestId: crypto.randomUUID(),
					}),
				)
				.then(data);
		const alpha = await makeProject(first.id, "Alpha");
		const beta = await makeProject(first.id, "Beta");
		const gamma = await makeProject(second.id, "Gamma");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		const url = `${workspace.origin}/organizations/${first.id}/projects/${beta.id}/executions`;
		await page.goto(url);
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.choose_project({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("option", { name: beta.name, exact: true }),
		).toHaveAttribute("data-checked", "true");
		await page
			.getByRole("menuitem", { name: m.new_project({}, options), exact: true })
			.click();
		const createProject = page.getByRole("dialog", {
			name: m.create_project({}, options),
			exact: true,
		});
		await expect(createProject).toHaveCSS("top", "32px");
		await expect(page).toHaveURL(url);
		await createProject
			.getByLabel(m.project_name({}, options), { exact: true })
			.fill("Created in place");
		await createProject
			.getByRole("button", { name: m.create_project({}, options), exact: true })
			.click();
		await expect(createProject).toHaveCount(0);
		await expect(page).toHaveURL(url);
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.create_project({}, options),
				exact: true,
			})
			.click();
		await expect(createProject).toBeVisible();
		await createProject
			.getByRole("button", { name: m.cancel({}, options), exact: true })
			.click();
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.choose_organization({}, options),
				exact: true,
			})
			.click();
		const selectedOrg = page.getByRole("option", {
			name: first.name,
			exact: true,
		});
		await expect(
			selectedOrg.getByText(m.role_owner({}, options), { exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: test.info().outputPath(`workspace-selector-${locale}.png`),
		});
		expect((await selectedOrg.boundingBox())?.height).toBeLessThanOrEqual(40);
		await page
			.getByRole("menuitem", {
				name: m.new_organization({}, options),
				exact: true,
			})
			.click();
		const createOrg = page.getByRole("dialog", {
			name: m.create_organization({}, options),
			exact: true,
		});
		await createOrg
			.getByLabel(m.organization_name({}, options), { exact: true })
			.fill("Created organization");
		await createOrg
			.getByRole("button", {
				name: m.create_organization({}, options),
				exact: true,
			})
			.click();
		await expect(createOrg).toHaveCount(0);
		await expect(page).toHaveURL(url);
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.create_organization({}, options),
				exact: true,
			})
			.click();
		await expect(createOrg).toBeVisible();
		await page.keyboard.press("Escape");
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.invite_members({}, options),
				exact: true,
			})
			.click();
		const invite = page.getByRole("dialog", {
			name: m.invite_others_to({ organization: first.name }, options),
			exact: true,
		});
		await expect(
			invite.getByLabel(m.email_address({}, options), { exact: true }),
		).toBeVisible();
		await expect(page).toHaveURL(url);
		await invite
			.getByRole("button", { name: m.cancel({}, options), exact: true })
			.click();
		await chooseOrganization(page, second.name, locale);
		await expect(page).toHaveURL(
			`${workspace.origin}/organizations/${second.id}/projects/${gamma.id}/executions`,
		);
		await chooseOrganization(page, first.name, locale);
		await expect(page).toHaveURL(url);
		await chooseProject(page, alpha.name, locale);
		const alphaUrl = `${workspace.origin}/organizations/${first.id}/projects/${alpha.id}/executions`;
		await expect(page).toHaveURL(alphaUrl);
		await page.goto(workspace.origin);
		await expect(page).toHaveURL(alphaUrl);
		await page.goto(`${workspace.origin}/settings?section=user`);
		await expect(
			page.getByRole("button", {
				name: m.switch_workspace({}, options),
				exact: true,
			}),
		).toContainText(alpha.name);
		await page.reload();
		await expect(
			page.getByRole("button", {
				name: m.switch_workspace({}, options),
				exact: true,
			}),
		).toContainText(alpha.name);
		const cookie = (await page.context().cookies()).find(
			(cookie) => cookie.name === workspaceCookieName(owner.userId),
		);
		expect(cookie).toBeDefined();
	});
}
