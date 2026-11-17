import { m } from "@recount/i18n/messages";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import { gate as createGate } from "../gate";
import {
	changeMemberRole,
	data,
	expect,
	memberRole,
	openProjectGrant,
	settingsUrl,
	test,
} from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`typed member and grant forms keep pending drafts and uncertain writes explicit in ${locale}`, async ({
		page,
		browser,
		workspace,
	}) => {
		const options = { locale };
		const email = "target@example.invalid";
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Typed forms",
					slug: "typed-forms",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Private",
				}),
			),
		);
		const target = await workspace.signIn(page, email);
		const member = await workspace.auth.api.addMember({
			body: {
				organizationId: organization.id,
				userId: target.userId,
				role: "member",
			},
		});
		await workspace.signIn(page, "owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		const membersUrl = settingsUrl(
			`${workspace.origin}/organizations/${organization.id}`,
			"organization-members",
		);
		const grantsUrl = settingsUrl(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}`,
			"project-members",
		);
		const noScript = await browser.newContext({
			javaScriptEnabled: false,
			storageState: await page.context().storageState(),
		});
		try {
			const ssr = await noScript.newPage();
			for (const url of [membersUrl, grantsUrl]) {
				await ssr.goto(url);
				if (url === membersUrl) {
					await expect(
						ssr.getByRole("button", {
							name: m.settings_member_actions({ email }, options),
							exact: true,
						}),
					).toBeDisabled();
					continue;
				}
				await expect(
					ssr.getByRole("button", {
						name: m.project_add_member({}, options),
						exact: true,
					}),
				).toBeDisabled();
				await expect(
					ssr.getByLabel(m.project_role_for({ email }, options), {
						exact: true,
					}),
				).toHaveCount(0);
			}
		} finally {
			await noScript.close();
		}

		for (const kind of ["member", "grant"] as const) {
			await page.goto(kind === "member" ? membersUrl : grantsUrl);
			if (kind === "grant") await openProjectGrant(page, email, locale);
			const select = page.getByLabel(m.project_role_for({ email }, options), {
				exact: true,
			});
			// Member roles change from the row menu; new grants are a dialog form.
			const submit = select
				.locator("xpath=ancestor::form")
				.locator('button[type="submit"]');
			if (kind === "grant") {
				await expect(submit).toHaveAccessibleName(
					m.save_grant_for({ email }, options),
				);
				await expect(submit).toBeEnabled();
				await select.selectOption("member");
			}
			const { promise: received, release: ready } = createGate();
			const { promise: gate, release } = createGate();
			let writes = 0;
			await page.route("**/_serverFn/**", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				writes++;
				await route.fetch();
				ready();
				await gate;
				await route.abort();
			});
			if (kind === "member")
				await changeMemberRole(
					page,
					email,
					m.role_upgrade_to_admin({}, options),
					locale,
				);
			else await submit.click();
			await received;
			if (kind === "member")
				await expect(memberRole(page, email)).toHaveAttribute(
					"aria-busy",
					"true",
				);
			else {
				await expect(submit).toBeDisabled();
				await expect(submit).toHaveAttribute("aria-busy", "true");
				await expect(select).toBeDisabled();
			}
			await expect(
				page.getByLabel(m.language({}, options), { exact: true }),
			).toHaveCount(0);
			release();
			await expect(page.getByRole("alert")).toContainText(
				kind === "member"
					? m.the_member_change_could_not_be_completed_refresh({}, options)
					: m.the_grant_change_could_not_be_completed_refresh({}, options),
			);
			if (kind === "member")
				await expect(memberRole(page, email)).toHaveText(
					m.role_admin({}, options),
				);
			else await expect(select).toHaveValue("member");
			expect(writes).toBe(1);
			await page.unroute("**/_serverFn/**");
			if (kind === "member") {
				expect(
					data(
						await workspace.operations(target.headers, (actor) =>
							organizationDomain.getOrganization(
								workspace.database.db,
								actor,
								organization.id,
							),
						),
					).role,
				).toBe("admin");
				data(
					await workspace.operations(owner.headers, (actor) =>
						memberDomain.updateRole(
							workspace.database.db,
							workspace.auth,
							owner.headers,
							actor,
							{
								organizationId: organization.id,
								memberId: member.id,
								role: "member",
							},
						),
					),
				);
			} else {
				expect(
					data(
						await workspace.operations(target.headers, (actor) =>
							projectDomain.getProject(workspace.database.db, actor, {
								organizationId: organization.id,
								projectId: project.id,
							}),
						),
					).role,
				).toBe("member");
			}
		}
	});
}

for (const kind of ["member", "grant"] as const) {
	test(`fragment navigation releases a retained ${kind} form before its old response arrives`, async ({
		page,
		workspace,
	}) => {
		const email = "target@example.invalid";
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Abandoned drafts",
					slug: "abandoned-drafts",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Private",
				}),
			),
		);
		const target = await workspace.signIn(page, email);
		await workspace.auth.api.addMember({
			body: {
				organizationId: organization.id,
				userId: target.userId,
				role: "member",
			},
		});
		await workspace.signIn(page, "owner@example.invalid");
		const url = settingsUrl(
			`${workspace.origin}/organizations/${organization.id}${kind === "member" ? "" : `/projects/${project.id}`}`,
			kind === "member" ? "organization-members" : "project-members",
		);
		await page.goto(url);
		if (kind === "grant") await openProjectGrant(page, email);
		const select = page.getByLabel(`Project role for ${email}`, {
			exact: true,
		});
		// Member roles change from the row menu; new grants are a dialog form.
		const submit = page.getByRole("button", {
			name: `Save project grant for ${email}`,
			exact: true,
		});
		if (kind === "grant") {
			await expect(submit).toBeEnabled();
			await select.selectOption("member");
		}
		const { promise: gate, release } = createGate();
		let received = false;
		let settled = false;
		let writes = 0;
		await page.route("**/_serverFn/**", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			writes++;
			const response = await route.fetch();
			received = true;
			await gate;
			await route.fulfill({ response }).catch(() => {});
			settled = true;
		});
		try {
			if (kind === "member")
				await changeMemberRole(page, email, "Upgrade to admin");
			else await submit.click();
			await expect.poll(() => received).toBe(true);
			await page.evaluate(() => {
				window.location.hash = "main-content";
			});
			await expect(page).toHaveURL(`${url}#main-content`);
			if (kind === "grant") {
				await expect(submit).toBeEnabled();
				await expect(select).toHaveValue("member");
			} else await expect(memberRole(page, email)).toHaveText("Admin");
			release();
			await expect.poll(() => settled).toBe(true);
			await expect(
				page.getByRole("button", { name: "Dismiss notice", exact: true }),
			).toHaveCount(0);
			await expect(page).toHaveURL(`${url}#main-content`);
			expect(writes).toBe(1);
		} finally {
			release();
		}
	});
}
