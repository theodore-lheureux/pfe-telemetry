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

test("insights are saved from Explore and managed from the Saved list", async ({
	page,
	workspace,
}, testInfo) => {
	const actor = await workspace.signIn(
		page,
		`saved-insights-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Saved insights",
				slug: `saved-insights-${randomUUID()}`,
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
		await clickhouse.command({
			query: `INSERT INTO telemetry.metric_points
        SELECT * REPLACE ({project:String} AS project_id)
        FROM telemetry.metric_points
        WHERE metric_name = 'recount.node.cpu.time'
          AND time_unix_nano > toUInt64(now() - INTERVAL 15 MINUTE) * 1000000000
        LIMIT 20000`,
			query_params: { project: project.id },
		});
		const insights = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}/insights`;
		await page.goto(`${insights}/saved`);
		await expect(
			page.getByRole("heading", { name: "No saved insights yet" }),
		).toBeVisible();
		await page.getByRole("link", { name: "Open Explore", exact: true }).click();

		// A new insight from a calculated metric is named after what it plots until
		// it is given a name and description in the title.
		const name = page.getByLabel("Insight name", { exact: true });
		await expect(name).toHaveAttribute("placeholder", "New insight");
		await page
			.getByRole("combobox", { name: "Choose a metric", exact: true })
			.click();
		await page.getByRole("option", { name: /^CPU usage/ }).click();
		await expect(name).toHaveAttribute("placeholder", "CPU usage");
		await name.fill("Fleet CPU");
		await page
			.getByLabel("Description", { exact: true })
			.fill("Busy share of every node's CPU");
		await page.getByRole("button", { name: "Add tag", exact: true }).click();
		await page.getByLabel("Tag", { exact: true }).fill("cpu");
		await page.getByRole("button", { name: "Save tag", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Remove tag cpu", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page).toHaveURL(/[?&]insight=[0-9a-f-]{36}/);
		await expect(
			page.getByRole("heading", { name: "Fleet CPU", exact: true }),
		).toBeAttached();

		// Edits mark the insight changed until they are saved.
		const save = page.getByRole("button", { name: "Save", exact: true });
		await expect(save).toBeDisabled();
		await page.getByRole("combobox", { name: "Group by", exact: true }).click();
		await page.getByRole("option", { name: "Node", exact: true }).click();
		await expect(page.getByText("Unsaved changes")).toBeVisible();
		await save.click();
		await expect(page.getByText("Unsaved changes")).toBeHidden();
		await expect(save).toBeDisabled();
		await page.mouse.wheel(0, -2000);
		await page.screenshot({
			path: testInfo.outputPath("saved-insight-title.png"),
		});

		// The list opens, renames, duplicates and deletes saved insights.
		await page.getByRole("link", { name: "Saved", exact: true }).click();
		const list = page.getByRole("table", { name: "Saved" });
		await expect(list.getByRole("link", { name: "Fleet CPU" })).toBeVisible();
		await expect(
			list.getByText("Busy share of every node's CPU"),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Actions for Fleet CPU", exact: true })
			.click();
		await page.getByRole("menuitem", { name: "Rename" }).click();
		const rename = page.getByRole("dialog", { name: "Rename insight" });
		await rename.getByLabel("Insight name").fill("Fleet CPU usage");
		await rename.getByRole("button", { name: "Save", exact: true }).click();
		await expect(rename).toBeHidden();
		await expect(
			list.getByRole("link", { name: "Fleet CPU usage", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Actions for Fleet CPU usage", exact: true })
			.click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();
		await expect(
			list.getByRole("link", { name: "Fleet CPU usage (copy)", exact: true }),
		).toBeVisible();
		// Selected insights get tags in bulk; the Tags filter narrows by them.
		await expect(list.getByText("cpu", { exact: true })).toBeVisible();
		await list
			.getByRole("checkbox", { name: "Select Fleet CPU usage", exact: true })
			.check();
		await page.getByRole("button", { name: "Update tags" }).click();
		const tagging = page.getByRole("dialog");
		await tagging.getByLabel("Tags", { exact: true }).fill("fleet");
		await tagging.getByLabel("Tags", { exact: true }).press("Enter");
		await expect(
			tagging.getByRole("button", { name: "Remove tag fleet", exact: true }),
		).toBeVisible();
		await tagging
			.getByRole("button", { name: "Add tags", exact: true })
			.click();
		await expect(list.getByText("fleet", { exact: true })).toBeVisible();
		await expect(page.getByText("1 selected")).toBeHidden();
		await page.getByRole("button", { name: /^Tags/, expanded: false }).click();
		await page.getByRole("option", { name: "fleet" }).click();
		await page.keyboard.press("Escape");
		await expect(list.getByRole("row")).toHaveCount(2);
		await page.getByRole("button", { name: /^Tags/, expanded: false }).click();
		await page.getByRole("option", { name: "Clear selection" }).click();
		await page.keyboard.press("Escape");
		// The toolbar filters by chart type and creator; search narrows by name.
		await page.getByRole("button", { name: "All types" }).click();
		await page.getByRole("option", { name: "Line chart" }).click();
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: /^Created by/, expanded: false })
			.click();
		await page.getByRole("option", { name: /\(you\)/ }).click();
		await page.keyboard.press("Escape");
		await expect(list.getByRole("row")).toHaveCount(3);
		await page.getByLabel("Search saved insights").fill("copy");
		await expect(list.getByRole("row")).toHaveCount(2);
		// Selected rows are deleted together after confirmation.
		await list
			.getByRole("checkbox", { name: "Select Fleet CPU usage (copy)" })
			.check();
		await expect(page.getByText("1 selected")).toBeVisible();
		await page.getByRole("button", { name: "Delete selected" }).click();
		const confirm = page.getByRole("alertdialog");
		await confirm.getByRole("button", { name: "Delete", exact: true }).click();
		// The open dialog hides the page from the accessibility tree; wait for it to close.
		await expect(confirm).toBeHidden();
		await expect(page.getByText("1 selected")).toBeHidden();
		await page.getByLabel("Search saved insights").fill("");
		await expect(
			list.getByRole("link", { name: "Fleet CPU usage", exact: true }),
		).toBeVisible();
		await expect(
			list.getByRole("link", { name: "Fleet CPU usage (copy)", exact: true }),
		).toBeHidden();
		await page.screenshot({
			path: testInfo.outputPath("saved-insights.png"),
			fullPage: true,
		});
		await list
			.getByRole("link", { name: "Fleet CPU usage", exact: true })
			.click();
		await expect(page.getByLabel("Insight name", { exact: true })).toHaveValue(
			"Fleet CPU usage",
		);
		await expect(
			page.getByRole("combobox", { name: "Group by", exact: true }),
		).toHaveText("Node");
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
