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
		// The same points an hour earlier, so the previous period has data to compare with
		// even when the local stack was recreated recently.
		await clickhouse.command({
			query: `INSERT INTO telemetry.metric_points
        SELECT * REPLACE (
            time_unix_nano - 3600000000000 AS time_unix_nano,
            toUInt32(intDiv(time_unix_nano - 3600000000000, 86400000000000)) AS event_day)
        FROM telemetry.metric_points
        WHERE project_id = {project:String}`,
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
		await page
			.getByRole("combobox", { name: "Choose a metric", exact: true })
			.click();
		await page.screenshot({
			path: testInfo.outputPath("insights-metric-picker.png"),
		});
		await page
			.getByRole("option", { name: /recount\.node\.cpu\.time/ })
			.click();
		// Known metrics show their friendly name and a description.
		await expect(
			page.getByRole("combobox", { name: "Node CPU time", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "About this metric", exact: true })
			.hover();
		await expect(
			page
				.getByRole("tooltip")
				.getByText("CPU time the node spent in each mode", { exact: false }),
		).toBeVisible();
		// Counters default to a per-second rate; averaging a counter is not offered.
		const calculation = page.getByRole("combobox", {
			name: "Calculation",
			exact: true,
		});
		await expect(calculation).toHaveText("Rate per second");
		await calculation.click();
		await expect(page.getByRole("option", { name: "Average" })).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("img", { name: "Insight chart", exact: true }),
		).toBeVisible();
		// A second series and a formula: the busy share of CPU time.
		await page.getByRole("button", { name: "Add series", exact: true }).click();
		await page
			.getByRole("combobox", { name: "Choose a metric", exact: true })
			.click();
		await page
			.getByRole("option", { name: /recount\.node\.cpu\.time/ })
			.click();
		await page.getByLabel("Formula mode", { exact: true }).click();
		await page.getByLabel("Formula 1", { exact: true }).fill("A / B * 100");
		const results = page.getByRole("table", { name: "Results" });
		await expect(
			results.getByRole("cell", { name: "A / B * 100", exact: true }),
		).toBeVisible();
		await expect(results.getByRole("row")).toHaveCount(2);
		// The editor's state is in the URL, so a reload restores it.
		await page.reload();
		await expect(page.getByLabel("Formula 1", { exact: true })).toHaveValue(
			"A / B * 100",
		);
		await page.getByLabel("Formula mode", { exact: true }).click();
		await page.getByRole("combobox", { name: "Group by", exact: true }).click();
		await page.getByRole("option", { name: "Node", exact: true }).click();
		await expect
			.poll(() => results.getByRole("row").count())
			.toBeGreaterThan(2);
		await page
			.getByRole("combobox", { name: "Comparison", exact: true })
			.click();
		await page
			.getByRole("option", { name: "Previous period", exact: true })
			.click();
		await expect(
			results.getByRole("cell", { name: /\(previous\)/ }).first(),
		).toBeVisible();
		// A calculated metric fills in named series and a formula from the picker.
		await page
			.getByRole("combobox", { name: "Comparison", exact: true })
			.click();
		await page
			.getByRole("option", { name: "No comparison", exact: true })
			.click();
		await page.getByRole("button", { name: "Add series", exact: true }).click();
		await page
			.getByRole("combobox", { name: "Choose a metric", exact: true })
			.click();
		await page.getByRole("option", { name: /^CPU usage/ }).click();
		await expect(page.getByLabel("Formula 1", { exact: true })).toHaveValue(
			"A",
		);
		await expect(page.getByLabel("Formula 2", { exact: true })).toHaveValue(
			"B",
		);
		await expect(page.getByLabel("Formula 3", { exact: true })).toHaveValue(
			"C / D * 100",
		);
		await expect(
			page.getByLabel("Formula 3 name", { exact: true }),
		).toHaveValue("CPU usage");
		await expect(
			results.getByRole("cell", { name: /^CPU usage · / }).first(),
		).toBeVisible();
		// Dragging across the chart narrows the range to the selected span.
		const range = page.getByRole("button", { name: /^Time range: / });
		await expect(range).toHaveAccessibleName(/Last hour/);
		const chart = page.getByRole("img", { name: "Insight chart", exact: true });
		const box = await chart.boundingBox();
		if (!box) throw new Error("chart has no box");
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + box.width * 0.4, y);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
		await page.mouse.up();
		await expect(range).not.toHaveAccessibleName(/Last hour/);
		// Edits are history steps: ⌘Z, ⇧⌘Z and the browser's Back move between them.
		await page.keyboard.press("ControlOrMeta+z");
		await expect(range).toHaveAccessibleName(/Last hour/);
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await expect(range).not.toHaveAccessibleName(/Last hour/);
		await page.goBack();
		await expect(range).toHaveAccessibleName(/Last hour/);
		await page.goForward();
		await expect(range).not.toHaveAccessibleName(/Last hour/);
		await page.screenshot({
			path: testInfo.outputPath("insights-grouped.png"),
			fullPage: true,
		});
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
