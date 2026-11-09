import { actorService } from "../../src/auth/actor.server";
import * as credentialDomain from "../../src/credentials/credentials.server";
import * as executionDomain from "../../src/executions/executions.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";

import { data, expect, openPreferences, test } from "./fixtures";

test("a completed execution keeps its saved acknowledgement and link after Skip to content", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(
		page,
		"execution-fragment@example.invalid",
	);
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Saved execution",
				slug: "saved-execution",
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
	const reference = { organizationId: organization.id, projectId: project.id };
	data(
		await actorService(workspace.auth)(owner.headers, (actor) =>
			credentialDomain.createCollectorCredential(workspace.database.db, actor, {
				...reference,
				name: "Source",
				sourceId: "fragment-source",
				rootId: "node1",
				rootKind: 1,
				adapter: "linux",
				allowedLocalKinds: [4],
			}),
		),
	);
	const requests = actorService(workspace.auth);
	const url = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`;
	await page.goto(url);
	let writes = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().includes("/_serverFn/"))
			writes++;
	});
	await page
		.getByLabel("Execution name", { exact: true })
		.fill("Fragment capture");
	await page
		.getByLabel("Start (UTC ISO timestamp)")
		.fill("2026-11-03T10:00:00Z");
	await page
		.getByLabel("End (UTC ISO timestamp, exclusive)")
		.fill("2026-11-03T11:00:00Z");
	await page
		.getByLabel("Start (UTC ISO timestamp)")
		.fill("2026-11-03T10:00:00.0001Z");
	await page
		.getByRole("button", { name: "Record execution", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(m.error_invalid_range());
	expect(writes).toBe(0);
	await page
		.getByLabel("Start (UTC ISO timestamp)")
		.fill("2026-11-03T10:00:00Z");
	await page
		.getByRole("button", { name: "Record execution", exact: true })
		.click();
	const saved = page.getByRole("link", {
		name: "Open saved execution",
		exact: true,
	});
	await expect(saved).toBeVisible();
	await expect(saved.locator("xpath=ancestor::form")).toHaveAttribute(
		"aria-busy",
		"false",
	);
	const destination = await saved.getAttribute("href");
	if (!destination) throw new Error("Expected the saved execution destination");
	await page
		.getByRole("link", { name: "Skip to content", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`${url}#main-content`);
	await expect(saved).toBeVisible();
	await expect(saved).toHaveAttribute("href", destination);
	await expect(page.getByRole("status")).toContainText("Execution recorded");
	await expect(
		page.getByText("The recording response did not arrive.", { exact: false }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Record execution", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Retry the same creation", exact: true }),
	).toHaveCount(0);
	expect(writes).toBe(1);
	expect(
		data(
			await requests(owner.headers, (actor) =>
				executionDomain.listExecutions(workspace.database.db, actor, reference),
			),
		).executions,
	).toHaveLength(1);
	await saved.click();
	const apply = page.getByRole("button", {
		name: m.apply_interval(),
		exact: true,
	});
	await expect(apply).toBeVisible();
	const range = apply.locator("xpath=ancestor::form");
	const beforeRange = page.url();
	await range.getByLabel(m.start_utc_iso()).fill("2026-11-03T10:00:00.0001Z");
	await apply.click();
	await expect(range.getByRole("alert")).toHaveText(m.error_invalid_range());
	await expect(page).toHaveURL(beforeRange);
	await range.getByLabel(m.start_utc_iso()).fill("2026-11-03T11:00:00+01:00");
	await apply.click();
	await expect(page).toHaveURL(/from=2026-11-03T10%3A00%3A00\.000Z/);
});

for (const failure of ["unknown-write", "refresh", "refresh-away"] as const) {
	test(`execution creation handles ${failure} without repeating a write`, async ({
		page,
		workspace,
	}) => {
		const owner = await workspace.signIn(page, "execution-ui@example.invalid");
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Executions",
					slug: "executions",
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
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const credentials = actorService(workspace.auth);
		data(
			await credentials(owner.headers, (actor) =>
				credentialDomain.createCollectorCredential(
					workspace.database.db,
					actor,
					{
						...reference,
						name: "Source",
						sourceId: "ui-source",
						rootId: "node1",
						rootKind: 1,
						adapter: "linux",
						allowedLocalKinds: [4],
					},
				),
			),
		);
		const requests = actorService(workspace.auth);
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`,
		);
		await page
			.getByLabel("Execution name", { exact: true })
			.fill("Saved capture");
		await page
			.getByLabel("Start (UTC ISO timestamp)")
			.fill("2026-11-03T10:00:00Z");
		await page
			.getByLabel("End (UTC ISO timestamp, exclusive)")
			.fill("2026-11-03T11:00:00Z");
		let started = false;
		let writes = 0;
		const bodies: string[] = [];
		await page.route("**/_serverFn/**", async (route) => {
			if (route.request().method() === "POST") {
				started = true;
				writes++;
				bodies.push(route.request().postData() ?? "");
				if (failure === "unknown-write") {
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					return route.abort();
				}
				return route.continue();
			}
			return started && failure !== "unknown-write"
				? route.abort()
				: route.continue();
		});
		await page
			.getByRole("button", { name: "Record execution", exact: true })
			.click();
		if (failure === "unknown-write") {
			await expect(page.getByRole("status")).toContainText(
				"The recording response did not arrive.",
			);
			await expect(
				page.getByRole("button", { name: "Record execution", exact: true }),
			).toBeDisabled();
			expect(
				data(
					await requests(owner.headers, (actor) =>
						executionDomain.listExecutions(
							workspace.database.db,
							actor,
							reference,
						),
					),
				).executions,
			).toHaveLength(1);
			await page.unroute("**/_serverFn/**");
			await page.route("**/_serverFn/**", (route) => {
				if (route.request().method() === "POST") {
					writes++;
					bodies.push(route.request().postData() ?? "");
				}
				return route.continue();
			});
			await page
				.getByRole("button", { name: "Retry the same creation", exact: true })
				.click();
			await expect(
				page.getByRole("link", { name: "Saved capture", exact: true }),
			).toBeVisible();
			expect(writes).toBe(2);
			expect(bodies[1]).toBe(bodies[0]);
			expect(
				data(
					await requests(owner.headers, (actor) =>
						executionDomain.listExecutions(
							workspace.database.db,
							actor,
							reference,
						),
					),
				).executions,
			).toHaveLength(1);
			return;
		} else {
			await expect(
				page.getByRole("heading", { name: "Something went wrong" }),
			).toBeVisible();
			await expect(page.getByRole("status")).toContainText(
				"Execution recorded",
			);
			expect(
				data(
					await requests(owner.headers, (actor) =>
						executionDomain.listExecutions(
							workspace.database.db,
							actor,
							reference,
						),
					),
				).executions,
			).toHaveLength(1);
			await page.unroute("**/_serverFn/**");
			if (failure === "refresh-away") {
				await page.getByRole("link", { name: "Go home", exact: true }).click();
				await expect(page.getByText(/^Execution recorded/)).toHaveCount(0);
				await openPreferences(page);
				await page.getByLabel("Language", { exact: true }).selectOption("fr");
				await expect(
					page.getByRole("alertdialog", {
						name: "Change language and reload?",
					}),
				).toBeVisible();
				await page
					.getByRole("button", { name: "Change language", exact: true })
					.click();
				await expect(page.locator("html")).toHaveAttribute("lang", "fr");
				expect(writes).toBe(1);
				return;
			}
			await page
				.getByRole("button", { name: "Try again", exact: true })
				.click();
			await expect(
				page.getByRole("link", { name: "Saved capture", exact: true }),
			).toBeVisible();
			expect(
				data(
					await requests(owner.headers, (actor) =>
						executionDomain.listExecutions(
							workspace.database.db,
							actor,
							reference,
						),
					),
				).executions,
			).toHaveLength(1);
		}
		expect(writes).toBe(1);
	});
}

import { m } from "@recount/i18n/messages";
