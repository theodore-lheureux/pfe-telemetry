import { createCollectorCredentialRequests } from "../../src/credentials/credentials.server";
import { createExecutionRequests } from "../../src/executions/request.server";
import { data, expect, test } from "./fixtures";

for (const failure of ["unknown-write", "refresh", "refresh-away"] as const) {
	test(`execution creation handles ${failure} without repeating a write`, async ({
		page,
		workspace,
	}) => {
		const owner = await workspace.signIn(page, "execution-ui@example.invalid");
		const organization = data(
			await workspace.operations.createOrganization(owner.headers, {
				name: "Executions",
				slug: "executions",
			}),
		);
		const project = data(
			await workspace.operations.createProject(owner.headers, {
				organizationId: organization.id,
				name: "Private",
				slug: "private",
			}),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const credentials = createCollectorCredentialRequests(
			workspace.database.db,
			workspace.auth,
		);
		data(
			await credentials.createCollectorCredential(owner.headers, {
				...reference,
				name: "Source",
				sourceId: "ui-source",
				hosts: ["node1"],
			}),
		);
		const requests = createExecutionRequests(
			workspace.database.db,
			workspace.auth,
		);
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
		await page.route("**/_serverFn/**", async (route) => {
			if (route.request().method() === "POST") {
				started = true;
				writes++;
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
				data(await requests.listExecutions(owner.headers, reference))
					.executions,
			).toHaveLength(1);
		} else {
			await expect(
				page.getByRole("heading", { name: "Something went wrong" }),
			).toBeVisible();
			await expect(page.getByRole("status")).toContainText(
				"Execution recorded",
			);
			expect(
				data(await requests.listExecutions(owner.headers, reference))
					.executions,
			).toHaveLength(1);
			await page.unroute("**/_serverFn/**");
			if (failure === "refresh-away") {
				await page.getByRole("link", { name: "Go home", exact: true }).click();
				await expect(page.getByText(/^Execution recorded/)).toHaveCount(0);
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
				data(await requests.listExecutions(owner.headers, reference))
					.executions,
			).toHaveLength(1);
		}
		expect(writes).toBe(1);
	});
}
