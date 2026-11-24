import { randomUUID } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";
import { clearTelemetry, seedRecentTelemetry } from "./telemetry-seed";

const allowed = process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH === "1";
test.skip(
	!allowed,
	"Requires the reused ClickHouse with recent node telemetry and disposable project permission",
);

test("Insights shows the Node health template and charts discovered metrics in Explore", async ({
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
		await seedRecentTelemetry(
			clickhouse,
			project.id,
			[
				"recount.node.cpu.time",
				"recount.node.memory.total",
				"recount.node.memory.available",
				"recount.collection.discovered.processes",
			],
			60,
			50_000,
			true,
		);
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}`,
		);
		await expect(
			page.getByRole("heading", { name: "Node health", exact: true }),
		).toBeVisible();
		for (const panel of [
			"CPU busy %",
			"Memory used %",
			"Processes",
			"Disk throughput",
			"Network throughput",
			"Nodes",
		])
			await expect(
				page.getByRole("article", { name: panel, exact: true }),
			).toBeVisible();
		const nodes = page.getByRole("article", { name: "Nodes", exact: true });
		await nodes.scrollIntoViewIfNeeded();
		await expect
			.poll(() => nodes.getByRole("table").getByRole("row").count())
			.toBeGreaterThan(1);
		await page.screenshot({
			path: testInfo.outputPath("insights-overview.png"),
			fullPage: true,
		});
		// The overview uses the shared range picker; a new range recomputes everything.
		await page
			.getByRole("button", {
				name: "Time range: No date range override",
				exact: true,
			})
			.click();
		await page
			.getByRole("option", { name: "Last 24 hours", exact: true })
			.click();
		await expect(
			page.getByRole("button", {
				name: "Time range: Last 24 hours",
				exact: true,
			}),
		).toBeVisible();
		await expect(page).toHaveURL(/filters=/);
		await page
			.getByRole("link", { name: "Dashboards", exact: true })
			.first()
			.click();
		await page
			.getByRole("button", {
				name: "New dashboard from a template",
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("menuitem", { name: /^Node health/ }),
		).toContainText("4 of 6 panels");
		await page.keyboard.press("Escape");
		await page.getByRole("link", { name: "Overview", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Node health", level: 1, exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: "Create dashboard from template",
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(/\/dashboards\/[^/]+$/);
		await expect(
			page.getByRole("button", { name: "Add insights", exact: true }),
		).toBeVisible();
		await expect(
			page
				.getByRole("article", { name: "CPU busy %", exact: true })
				.getByRole("link", { name: "CPU busy %", exact: true }),
		).toHaveAttribute("href", /insight=/);
		await page.getByRole("link", { name: "Explore", exact: true }).click();
		await page
			.getByRole("combobox", { name: "Choose a metric", exact: true })
			.click();
		const pickerPreview = page.locator('[data-slot="hover-card-content"]');
		await page.getByPlaceholder("Search metrics").fill("recount.node.cpu.time");
		await page.getByRole("option", { name: /^Node CPU/ }).hover();
		await expect(pickerPreview).toContainText("Node CPU");
		await expect(pickerPreview).toContainText("Counter");
		await page.getByPlaceholder("Search metrics").fill("no-such-metric");
		await expect(pickerPreview).toHaveCount(0);
		await page.getByPlaceholder("Search metrics").fill("Memory usage");
		await page.keyboard.press("ArrowDown");
		await expect(pickerPreview).toContainText("Memory usage");
		await page.getByPlaceholder("Search metrics").fill("recount.node.cpu.time");
		await page.getByRole("option", { name: /^Node CPU/ }).hover();
		await expect(pickerPreview).toContainText("Node CPU");
		await page.screenshot({
			path: testInfo.outputPath("insights-metric-picker.png"),
		});
		await page.getByRole("option", { name: /^Node CPU/ }).click();
		// Known metrics show their friendly name and a description.
		await expect(
			page.getByRole("combobox", { name: "Node CPU", exact: true }),
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
		await page.getByRole("option", { name: /^Node CPU/ }).click();
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
		await page.getByRole("button", { name: /^Breakdown:/ }).click();
		for (const name of ["Node", "Host", "Resource"])
			await expect(page.getByRole("option", { name, exact: true })).toHaveCount(
				0,
			);
		const breakdownList = page.getByRole("listbox", { name: "Suggestions" });
		const fullWidth = await breakdownList.evaluate((list) => list.clientWidth);
		await page.getByPlaceholder("Search attributes").fill("cpu.mode");
		await expect(pickerPreview).toContainText("CPU mode");
		await expect(pickerPreview).toContainText("String");
		await expect
			.poll(() => breakdownList.evaluate((list) => list.clientWidth))
			.toBe(fullWidth);
		await page.getByPlaceholder("Search attributes").fill("");
		await page
			.getByRole("option", { name: "No breakdown", exact: true })
			.hover();
		await expect(pickerPreview).toHaveCount(0);
		await expect
			.poll(() => breakdownList.evaluate((list) => list.clientWidth))
			.toBe(fullWidth);
		await page.getByRole("option", { name: /^CPU mode/ }).click();
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
		// Groups collapse into one line after the formula, such as p99 across nodes.
		await page
			.getByRole("combobox", { name: "Combine groups", exact: true })
			.click();
		await page
			.getByRole("option", { name: "99th percentile across groups" })
			.click();
		await expect(
			results
				.getByRole("cell", { name: /99th percentile across groups/ })
				.first(),
		).toBeVisible();
		await expect(
			results.getByRole("columnheader", { name: "p99", exact: true }),
		).toBeVisible();
		await page
			.getByRole("combobox", { name: "Combine groups", exact: true })
			.click();
		await page.getByRole("option", { name: "Show each group" }).click();
		// A calculated metric is one ordinary series; its inputs stay on the server.
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
		await expect(
			page.getByLabel("Formula mode", { exact: true }),
		).not.toBeChecked();
		await expect(
			page.getByRole("combobox", { name: "CPU usage", exact: true }),
		).toHaveCount(1);
		await expect(
			page.getByRole("combobox", { name: "Calculation", exact: true }),
		).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: /^Breakdown:/ }),
		).toHaveAccessibleName("Breakdown: No breakdown");
		await expect(
			results.getByRole("cell", { name: "C · CPU usage", exact: true }),
		).toBeVisible();
		const returnTo = page.url();
		await page
			.getByRole("link", { name: "View definition", exact: true })
			.click();
		await page
			.getByRole("link", { name: "Use as template", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save as calculated metric", exact: true })
			.click();
		let calculationDialog = page.getByRole("dialog", {
			name: "Save as calculated metric",
			exact: true,
		});
		const metricName = `Reusable CPU ${randomUUID()}`;
		await calculationDialog
			.getByRole("textbox", { name: "Name", exact: true })
			.fill(metricName);
		await calculationDialog
			.getByRole("button", { name: "Save", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: metricName, level: 1, exact: true }),
		).toBeVisible();
		const definitionUrl = page.url();
		await page
			.getByRole("link", { name: "Edit calculation", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Save calculated metric", exact: true })
			.click();
		calculationDialog = page.getByRole("dialog", {
			name: "Save calculated metric",
			exact: true,
		});
		await calculationDialog
			.getByRole("textbox", { name: "Name", exact: true })
			.fill(`${metricName} renamed`);
		await calculationDialog
			.getByRole("button", { name: "Save", exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: `${metricName} renamed`,
				level: 1,
				exact: true,
			}),
		).toBeVisible();
		await expect(page).toHaveURL(definitionUrl);
		await page
			.getByRole("link", { name: "Open in Explore", exact: true })
			.click();
		await expect(
			page.getByRole("combobox", {
				name: `${metricName} renamed`,
				exact: true,
			}),
		).toHaveCount(1);
		await expect(
			page.getByRole("combobox", { name: "Calculation", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByLabel("Formula mode", { exact: true }),
		).not.toBeChecked();
		await page.goto(returnTo);
		await expect(
			results.getByRole("cell", { name: "C · CPU usage", exact: true }),
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
		await clearTelemetry(clickhouse, project.id);
		await clickhouse.close();
	}
});
