import { m } from "@recount/i18n/messages";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import {
	data,
	editMemberRole,
	expect,
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
					slug: "private",
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
			for (const [url, label] of [
				[membersUrl, m.role_for({ email }, options)],
				[grantsUrl, m.project_role_for({ email }, options)],
			]) {
				await ssr.goto(url);
				if (url === membersUrl) {
					await expect(
						ssr.getByRole("button", {
							name: m.settings_member_actions({ email }, options),
							exact: true,
						}),
					).toBeDisabled();
					await expect(ssr.getByLabel(label, { exact: true })).toHaveCount(0);
					continue;
				}
				await expect(
					ssr.getByRole("button", {
						name: m.project_add_member({}, options),
						exact: true,
					}),
				).toBeDisabled();
				await expect(ssr.getByLabel(label, { exact: true })).toHaveCount(0);
			}
		} finally {
			await noScript.close();
		}

		for (const kind of ["member", "grant"] as const) {
			await page.goto(kind === "member" ? membersUrl : grantsUrl);
			if (kind === "member") await editMemberRole(page, email, locale);
			else await openProjectGrant(page, email, locale);
			const select = page.getByLabel(
				kind === "member"
					? m.role_for({ email }, options)
					: m.project_role_for({ email }, options),
				{ exact: true },
			);
			const submit = select
				.locator("xpath=ancestor::form")
				.locator('button[type="submit"]');
			await expect(submit).toHaveAccessibleName(
				kind === "member"
					? m.save_role_for({ email }, options)
					: m.save_grant_for({ email }, options),
			);
			await expect(submit).toBeEnabled();
			await select.selectOption(kind === "member" ? "admin" : "member");
			let ready!: () => void;
			let release!: () => void;
			const received = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let writes = 0;
			await page.route("**/_serverFn/**", async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				writes++;
				await route.fetch();
				ready();
				await gate;
				await route.abort();
			});
			await submit.click();
			await received;
			await expect(submit).toBeDisabled();
			await expect(submit).toHaveAttribute("aria-busy", "true");
			await expect(select).toBeDisabled();
			await expect(
				page.getByLabel(m.language({}, options), { exact: true }),
			).toHaveCount(0);
			release();
			await expect(page.getByRole("alert")).toContainText(
				kind === "member"
					? m.the_member_change_could_not_be_completed_refresh({}, options)
					: m.the_grant_change_could_not_be_completed_refresh({}, options),
			);
			await expect(select).toHaveValue(kind === "member" ? "admin" : "member");
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
					slug: "private",
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
		if (kind === "member") await editMemberRole(page, email);
		else await openProjectGrant(page, email);
		const select = page.getByLabel(
			kind === "member" ? `Role for ${email}` : `Project role for ${email}`,
			{ exact: true },
		);
		const submit = page.getByRole("button", {
			name:
				kind === "member"
					? `Save role for ${email}`
					: `Save project grant for ${email}`,
			exact: true,
		});
		await expect(submit).toBeEnabled();
		await select.selectOption(kind === "member" ? "admin" : "member");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
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
			await submit.click();
			await expect.poll(() => received).toBe(true);
			await page.evaluate(() => {
				window.location.hash = "main-content";
			});
			await expect(page).toHaveURL(`${url}#main-content`);
			await expect(submit).toBeEnabled();
			await expect(select).toHaveValue(kind === "member" ? "admin" : "member");
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
