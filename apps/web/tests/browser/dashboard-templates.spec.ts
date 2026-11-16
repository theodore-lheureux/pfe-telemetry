import { randomUUID } from "node:crypto";
import { m } from "@recount/i18n/messages";
import { listDashboardTemplates } from "../../src/analytics/dashboard-templates.server";
import { getDashboard } from "../../src/analytics/dashboards.server";
import { collectorNode, enrollmentKey } from "../../src/db/schema";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`dashboard gallery previews, fills node variables and reuses project snapshots in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const actor = await workspace.signIn(
			page,
			`templates-${randomUUID()}@example.invalid`,
		);
		const organization = data(
			await workspace.operations(actor.headers, () =>
				createOrganization(workspace.auth, actor.headers, {
					name: "Templates",
					slug: `templates-${randomUUID()}`,
				}),
			),
		);
		const project = data(
			await workspace.operations(actor.headers, (current) =>
				createProject(workspace.database.db, current, {
					organizationId: organization.id,
					requestId: randomUUID(),
					name: "Fleet",
				}),
			),
		);
		const reference = {
			organizationId: organization.id,
			projectId: project.id,
		};
		const keyId = randomUUID();
		const nodeId = randomUUID();
		await workspace.database.db.insert(enrollmentKey).values({
			id: keyId,
			...reference,
			name: "Template fixture",
			keySha256: randomUUID().replaceAll("-", "").repeat(2),
		});
		await workspace.database.db.insert(collectorNode).values({
			id: nodeId,
			...reference,
			enrollmentKeyId: keyId,
			machineId: "template-host",
			hostname: "Template host",
			publicKey: "a".repeat(43),
		});
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.setViewportSize(
			locale === "fr"
				? { width: 390, height: 844 }
				: { width: 1440, height: 1000 },
		);
		const listUrl = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/dashboards`;
		await page.goto(listUrl);
		await page
			.getByRole("button", { name: m.dashboard_new({}, options), exact: true })
			.click();
		let dialog = page.getByRole("dialog", {
			name: m.dashboard_new({}, options),
			exact: true,
		});
		await expect(
			dialog.getByRole("button", {
				name: m.dashboard_templates_blank({}, options),
				exact: true,
			}),
		).toHaveAttribute("aria-pressed", "true");
		await dialog
			.getByRole("button", {
				name: new RegExp(`^${m.dashboard_template_node_health({}, options)}`),
			})
			.click();
		const preview = dialog.getByRole("region", {
			name: m.dashboard_templates_preview({}, options),
		});
		await expect(preview).toContainText(
			m.dashboard_template_cpu_busy({}, options),
		);
		await expect(preview).toContainText(
			m.dashboard_template_network_throughput({}, options),
		);
		const variable = dialog.getByRole("combobox", {
			name: m.dashboard_templates_node_variable({}, options),
		});
		await expect(variable).toBeEnabled();
		await variable.click();
		await page
			.getByRole("option", { name: "Template host", exact: true })
			.click();
		await dialog
			.getByLabel(m.dashboard_name({}, options), { exact: true })
			.fill("Fleet health");
		await dialog
			.getByRole("button", { name: m.saved_save({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Fleet health", exact: true }),
		).toBeVisible();
		const createdId = new URL(page.url()).pathname.split("/").at(-1) as string;
		const created = data(
			await workspace.operations(actor.headers, (current) =>
				getDashboard(workspace.database.db, current, {
					...reference,
					dashboardId: createdId,
				}),
			),
		);
		expect(JSON.parse(created.filters)).toEqual({
			filters: [{ field: "node", op: "eq", values: [nodeId] }],
		});
		await page
			.getByRole("button", {
				name: m.dashboard_actions({ name: "Fleet health" }, options),
				exact: true,
			})
			.click();
		await page
			.getByRole("menuitem", {
				name: m.dashboard_templates_save_as({}, options),
				exact: true,
			})
			.click();
		dialog = page.getByRole("dialog", {
			name: m.dashboard_templates_save_as({}, options),
			exact: true,
		});
		await dialog
			.getByLabel(m.dashboard_name({}, options), { exact: true })
			.fill("Reusable fleet");
		await dialog.getByRole("checkbox").check();
		await dialog
			.getByRole("button", { name: m.saved_save({}, options), exact: true })
			.click();
		await expect(dialog).toBeHidden();
		const snapshots = data(
			await workspace.operations(actor.headers, (current) =>
				listDashboardTemplates(workspace.database.db, current, reference),
			),
		);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].template.variables).toEqual([
			{ name: "$node", field: "node" },
		]);
		expect(snapshots[0].template.filters).toBe("{}");
		await page.goto(listUrl);
		await page
			.getByRole("button", { name: m.dashboard_new({}, options), exact: true })
			.click();
		dialog = page.getByRole("dialog", {
			name: m.dashboard_new({}, options),
			exact: true,
		});
		await dialog.getByRole("button", { name: /^Reusable fleet/ }).click();
		await expect(
			dialog.getByRole("region", {
				name: m.dashboard_templates_preview({}, options),
			}),
		).toBeVisible();
		await expect(
			dialog.getByRole("combobox", {
				name: m.dashboard_templates_node_variable({}, options),
			}),
		).toHaveText(m.dashboard_templates_all_nodes({}, options));
		await dialog
			.getByRole("button", { name: m.saved_save({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Reusable fleet", exact: true }),
		).toBeVisible();
		const reusedId = new URL(page.url()).pathname.split("/").at(-1) as string;
		const reused = data(
			await workspace.operations(actor.headers, (current) =>
				getDashboard(workspace.database.db, current, {
					...reference,
					dashboardId: reusedId,
				}),
			),
		);
		expect(reused.filters).toBe("{}");
		expect(reused.tiles).toHaveLength(6);
		expect(reused.tiles[0].insight.id).not.toBe(created.tiles[0].insight.id);
		await page.goto(listUrl);
		await page
			.getByRole("button", { name: m.dashboard_new({}, options), exact: true })
			.click();
		dialog = page.getByRole("dialog", {
			name: m.dashboard_new({}, options),
			exact: true,
		});
		await dialog
			.getByRole("button", {
				name: m.dashboard_templates_blank({}, options),
				exact: true,
			})
			.click();
		await expect(
			dialog.getByRole("region", {
				name: m.dashboard_templates_preview({}, options),
			}),
		).toHaveCount(0);
		await dialog
			.getByLabel(m.dashboard_name({}, options), { exact: true })
			.fill("Blank fleet");
		await dialog
			.getByRole("button", { name: m.saved_save({}, options), exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Blank fleet", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("article")).toHaveCount(0);
	});
}
