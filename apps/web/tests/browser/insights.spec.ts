import { randomUUID } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

const allowed = process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH === "1";
test.skip(
	!allowed,
	"Requires the reused ClickHouse with recent node telemetry and disposable project permission",
);

test("Insights shows a fleet overview and charts discovered metrics in Explore", async ({
	page,
	workspace,
}, testInfo) => {
	const actor = await workspace.signIn(
		page,
		`insights-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Insights lab",
				slug: `insights-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Fleet",
			}),
		),
	);
	const clickhouse = createClient({
		url: process.env.RECOUNT_CLICKHOUSE_TEST_URL,
		username: process.env.RECOUNT_CLICKHOUSE_TEST_USER,
		password: process.env.RECOUNT_CLICKHOUSE_TEST_PASSWORD,
		log: { level: ClickHouseLogLevel.OFF },
	});
	try {
		// Copy an hour of real node CPU points into this disposable project; the discovery
		// views catalog them on insert, exactly as for collector traffic.
		await clickhouse.command({
			query: `INSERT INTO telemetry.metric_points
        SELECT * REPLACE ({project:String} AS project_id)
        FROM telemetry.metric_points
        WHERE metric_name IN ('recount.node.cpu.time', 'recount.node.memory.total',
            'recount.node.memory.available', 'recount.collection.discovered.processes')
          AND time_unix_nano > toUInt64(now() - INTERVAL 1 HOUR) * 1000000000
        LIMIT 50000`,
			query_params: { project: project.id },
		});
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/insights`,
		);
		await expect(
			page.getByRole("heading", { name: "Insights", exact: true }),
		).toBeVisible();
		// The overview: fixed stat tiles compared with the previous period.
		for (const stat of [
			"Nodes reporting",
			"CPU utilization",
			"Memory used",
			"Processes",
		])
			await expect(
				page.getByRole("button", {
					name: `Show ${stat} in the chart`,
					exact: true,
				}),
			).toBeVisible();
		await expect(
			page.getByRole("img", { name: "CPU utilization over time" }),
		).toBeVisible();
		await expect
			.poll(() =>
				page.getByRole("table", { name: "Nodes" }).getByRole("row").count(),
			)
			.toBeGreaterThan(1);
		await page.screenshot({
			path: testInfo.outputPath("insights-overview.png"),
			fullPage: true,
		});
		await page
			.getByRole("button", {
				name: "Show Memory used in the chart",
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("img", { name: "Memory used over time" }),
		).toBeVisible();
		await page.getByRole("link", { name: "Explore", exact: true }).click();
		await page.getByRole("combobox", { name: "Metric", exact: true }).click();
		await page.screenshot({
			path: testInfo.outputPath("insights-metric-picker.png"),
		});
		await page
			.getByRole("option", { name: /recount\.node\.cpu\.time/ })
			.click();
		// Known metrics show their friendly name and a description.
		await expect(
			page.getByRole("combobox", { name: "Metric", exact: true }),
		).toHaveText("Node CPU time");
		await expect(
			page.getByText("CPU time the node spent in each mode", { exact: false }),
		).toBeVisible();
		// Counters default to a per-second rate, summed across series.
		await expect(page.getByLabel("Calculation", { exact: true })).toHaveValue(
			"rate",
		);
		await expect(
			page.getByRole("img", { name: "Chart of Node CPU time" }),
		).toBeVisible();
		await page.getByLabel("Group by", { exact: true }).selectOption("node");
		const table = page.getByRole("table");
		// Grouping replaces the single combined series with one row per node.
		await expect(
			table.getByRole("cell", { name: "All", exact: true }),
		).toHaveCount(0);
		await expect.poll(() => table.getByRole("row").count()).toBeGreaterThan(2);
		await page.screenshot({
			path: testInfo.outputPath("insights-grouped.png"),
			fullPage: true,
		});
		// Averaging a counter is not offered; only its rate and increase are.
		await expect(
			page
				.getByLabel("Calculation", { exact: true })
				.locator("option", { hasText: "Average" }),
		).toHaveCount(0);
	} finally {
		for (const table of [
			"metric_points",
			"metric_definitions",
			"attribute_definitions",
		])
			await clickhouse.command({
				query: `ALTER TABLE telemetry.${table} DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 1`,
				query_params: { project: project.id },
			});
		await clickhouse.close();
	}
});
