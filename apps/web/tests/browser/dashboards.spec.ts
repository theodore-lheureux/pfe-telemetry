import { randomUUID } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { addTiles, saveDashboard } from "../../src/analytics/dashboards.server";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { saveInsight } from "../../src/analytics/saved-insights.server";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { settingsPath } from "../settings-path";
import { data, expect, test } from "./fixtures";

const allowed = process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH === "1";
test.skip(
	!allowed,
	"Requires the reused ClickHouse with recent node telemetry and disposable project permission",
);

test("dashboards arrange saved insights as tiles over one time range", async ({
	page,
	workspace,
}, testInfo) => {
	const actor = await workspace.signIn(
		page,
		`dashboards-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Dashboards",
				slug: `dashboards-${randomUUID()}`,
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
	const reference = { organizationId: organization.id, projectId: project.id };
	const save = async (name: string, display: "line" | "stat") =>
		data(
			await workspace.operations(actor.headers, (actor) =>
				saveInsight(workspace.database.db, actor, {
					...reference,
					insightId: randomUUID(),
					name,
					draft: encodeDraft({
						...DEFAULT_DRAFT,
						series: [
							{
								...newSeries("A"),
								metric: "recount.node.cpu.time",
								calculation: "rate",
								combine: "sum",
							},
						],
						display: { ...DEFAULT_DRAFT.display, type: display },
					}),
				}),
			),
		);
	await save("CPU over time", "line");
	await save("CPU now", "stat");
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
          AND time_unix_nano > toUInt64(now() - INTERVAL 30 MINUTE) * 1000000000
        LIMIT 20000`,
			query_params: { project: project.id },
		});
		await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/dashboards`,
		);
		await expect(
			page.getByRole("heading", { name: "No dashboards yet" }),
		).toBeVisible();
		await page.getByRole("button", { name: "New dashboard" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByLabel("Name").fill("Fleet health");
		await dialog.getByLabel("Description").fill("CPU across the fleet.");
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(
			page.getByRole("heading", { name: "Fleet health", level: 1 }),
		).toBeVisible();

		// Saved insights are chosen from a searchable list.
		await page.getByRole("button", { name: "Add insights" }).first().click();
		await page.getByRole("option", { name: "CPU over time" }).click();
		await page.getByRole("option", { name: "CPU now" }).click();
		await page.getByRole("button", { name: "Add 2" }).click();
		const tiles = page.getByRole("article");
		await expect(tiles).toHaveCount(2);
		await expect(
			tiles.first().getByRole("img", { name: "Insight chart" }),
		).toBeVisible();
		// The dashboard shows when it was last refreshed as a whole; each tile shows its
		// own time on its refresh button.
		await expect(page.getByText("Last refreshed")).toBeVisible();
		await expect(tiles.nth(1)).toHaveAttribute("aria-busy", "false");
		await page.getByRole("button", { name: "Refresh CPU now" }).hover();
		await expect(page.getByRole("tooltip")).toHaveText(/^Computed/);
		await page.mouse.move(0, 0);

		// Room for every tile, so moving one needs no scrolling.
		await page.setViewportSize({ width: 1440, height: 1600 });
		// Each tile sits in a grid cell, which carries its size.
		const cells = tiles.locator("xpath=..");
		// Tiles resize by dragging a side or corner: the tile follows the pointer and its
		// cell shows the size it snaps to. The corner handle also takes the arrow keys.
		const corner = page.getByRole("button", { name: "Resize CPU over time" });
		await corner.hover();
		const box = await corner.boundingBox();
		if (!box) throw new Error("The resize handle has no box");
		await page.mouse.down();
		await page.mouse.move(box.x + 1000, box.y + box.height / 2, { steps: 5 });
		await expect(cells.first()).toHaveClass(/lg:col-span-12/);
		await page.mouse.up();
		await expect(page.getByText("Changes saved")).toBeVisible();
		// Any side resizes too: the bottom one changes only the height.
		const card = await tiles.first().boundingBox();
		if (!card) throw new Error("The tile has no box");
		await expect(corner).toBeEnabled();
		await page.mouse.move(card.x + card.width / 2, card.y + card.height - 2);
		await page.mouse.down();
		await page.mouse.move(card.x + card.width / 2, card.y + card.height + 150, {
			steps: 5,
		});
		await page.mouse.up();
		await expect(cells.first()).toHaveClass(/row-span-4/);
		await expect(cells.first()).toHaveClass(/lg:col-span-12/);
		const resize = page.getByRole("button", { name: "Resize CPU now" });
		await expect(resize).toBeEnabled();
		await resize.focus();
		await page.keyboard.press("ArrowDown");
		await expect(cells.nth(1)).toHaveClass(/row-span-4/);
		// The left side moves the tile's start and keeps its right side in place.
		await expect(resize).toBeEnabled();
		const second = await tiles.nth(1).boundingBox();
		if (!second) throw new Error("The tile has no box");
		const column = (second.width + 16) / 6;
		await page.mouse.move(second.x + 2, second.y + second.height / 2);
		await page.mouse.down();
		await page.mouse.move(
			second.x + 2 + column * 3,
			second.y + second.height / 2,
			{
				steps: 5,
			},
		);
		await page.mouse.up();
		await expect(cells.nth(1)).toHaveClass(/lg:col-start-4/);
		await expect(cells.nth(1)).toHaveClass(/lg:col-span-3/);

		// A click on a tile's header picks it up and the next click drops it.
		await expect(resize).toBeEnabled();
		const header = tiles.nth(1).locator("header");
		const headerBox = await header.boundingBox();
		if (!headerBox) throw new Error("The header has no box");
		await header.click({ position: { x: headerBox.width * 0.6, y: 14 } });
		const target = await tiles.first().boundingBox();
		if (!target) throw new Error("The tile has no box");
		await page.mouse.move(
			target.x + target.width / 4,
			target.y + target.height / 2,
			{ steps: 10 },
		);
		const placeholder = page.locator("[data-drop-placeholder]");
		await expect(placeholder).toBeVisible();
		const predicted = await placeholder.boundingBox();
		if (!predicted) throw new Error("The drop placeholder has no box");
		await page.mouse.click(
			target.x + target.width / 4,
			target.y + target.height / 2,
		);
		await expect(tiles.first()).toContainText("CPU now");
		await expect(placeholder).toHaveCount(0);
		await expect
			.poll(async () => {
				const actual = await cells.first().boundingBox();
				if (!actual) return Number.POSITIVE_INFINITY;
				return Math.max(
					...(["x", "y", "width", "height"] as const).map((key) =>
						Math.abs(actual[key] - predicted[key]),
					),
				);
			})
			.toBeLessThan(1);
		// It goes where it was dropped, leaving the start column it had behind.
		await expect(cells.first()).not.toHaveClass(/col-start/);
		// ⌘Z undoes a layout change and ⇧⌘Z redoes it, each saved in turn.
		const idle = page.getByRole("button", { name: "Resize CPU now" });
		await expect(idle).toBeEnabled();
		await page.keyboard.press("ControlOrMeta+z");
		await expect(tiles.first()).toContainText("CPU over time");
		await expect(idle).toBeEnabled();
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await expect(tiles.first()).toContainText("CPU now");
		await expect(idle).toBeEnabled();
		// Pressing a header picks the tile up; releasing keeps it picked up, and the next
		// click drops it.
		const from = await tiles.first().locator("header").boundingBox();
		const to = await tiles.nth(1).boundingBox();
		if (!from || !to) throw new Error("The tiles have no box");
		await page.mouse.move(from.x + from.width * 0.6, from.y + 14);
		await page.mouse.down();
		await page.mouse.move(to.x + to.width / 4, to.y + to.height / 2, {
			steps: 10,
		});
		await page.mouse.up();
		await page.waitForTimeout(200);
		await expect(tiles.first()).toContainText("CPU now");
		await page.mouse.click(to.x + to.width / 4, to.y + to.height / 2);
		await expect(tiles.first()).toContainText("CPU over time");
		await expect(idle).toBeEnabled();
		await page.keyboard.press("ControlOrMeta+z");
		await expect(tiles.first()).toContainText("CPU now");
		await expect(idle).toBeEnabled();
		// The layout is stored, so a reload keeps it.
		await page.reload();
		await expect(tiles.first()).toContainText("CPU now");
		await expect(cells.first()).toHaveClass(/row-span-4/);
		await expect(cells.nth(1)).toHaveClass(/lg:col-span-12/);

		// Overrides apply to every tile, first in the URL and then saved.
		await page
			.getByRole("button", { name: "Time range: No date range override" })
			.click();
		for (const minutes of [5, 15, 30])
			await expect(
				page.getByRole("option", {
					name: `Last ${minutes} minutes`,
					exact: true,
				}),
			).toBeVisible();
		await page
			.getByRole("option", { name: "Last 24 hours", exact: true })
			.click();
		await expect(page).toHaveURL(/filters=/);
		await page.getByRole("button", { name: /^Breakdown:/ }).click();
		await page.getByRole("option", { name: /^Host name/ }).click();
		// Unsaved overrides are counted and outlined until saved or discarded.
		await expect(page.getByText("Unsaved filters: 2")).toBeVisible();
		// Its info lists each unsaved change, from the saved value to the current one.
		await page.getByRole("button", { name: "Unsaved changes" }).click();
		const changes = page.locator('[data-slot="hover-card-content"]');
		await expect(changes.getByText("No date range override")).toBeVisible();
		await expect(changes.getByText("Last 24 hours")).toBeVisible();
		await expect(changes.getByText("Host name", { exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Save filters" }).click();
		await expect(page).not.toHaveURL(/filters=/);
		await expect(page.getByText(/Unsaved filters/)).toBeHidden();
		await expect(
			page.getByRole("button", { name: "Save filters" }),
		).toBeHidden();
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Time range: Last 24 hours" }),
		).toBeVisible();
		await expect(
			tiles.nth(1).getByRole("img", { name: "Insight chart" }),
		).toBeVisible();
		// A tile's info shows its query and marks what the dashboard overrides.
		await page.getByRole("button", { name: "About CPU over time" }).hover();
		const info = page.locator('[data-slot="hover-card-content"]');
		await expect(info.getByText("Node CPU time")).toBeVisible();
		await expect(info.getByText("Host name", { exact: true })).toBeVisible();
		await expect(info.getByText("Dashboard")).toHaveCount(2);
		// A click pins it open after the pointer leaves; another click closes it.
		const about = page.getByRole("button", { name: "About CPU over time" });
		await about.click();
		await page.mouse.move(0, 0);
		await page.waitForTimeout(400);
		await expect(info).toBeVisible();
		await about.click();
		await page.mouse.move(0, 0);
		await expect(info).toBeHidden();
		// Auto refresh is a choice of this viewer, shown on the refresh button.
		await page.getByRole("button", { name: "Refresh options" }).click();
		await page
			.getByRole("menuitemcheckbox", { name: "Auto refresh while on page" })
			.click();
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: /^Refresh all/ }),
		).toContainText("1m");
		// Dragging across a chart narrows the dashboard's range to that span.
		const chart = await tiles
			.nth(1)
			.getByRole("img", { name: "Insight chart" })
			.boundingBox();
		if (!chart) throw new Error("The chart has no box");
		await page.mouse.move(
			chart.x + chart.width * 0.85,
			chart.y + chart.height / 2,
		);
		await page.mouse.down();
		await page.mouse.move(
			chart.x + chart.width * 0.97,
			chart.y + chart.height / 2,
			{
				steps: 5,
			},
		);
		await page.mouse.up();
		await expect(page.getByText("Unsaved filters: 1")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Time range: Last 24 hours" }),
		).toBeHidden();
		await page.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Time range: Last 24 hours" }),
		).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("dashboard.png"),
			fullPage: true,
		});

		// A tile far below the screen neither loads nor draws until it comes near.
		await page.setViewportSize({ width: 1440, height: 400 });
		await page.reload();
		const lower = tiles.nth(1);
		await expect(
			tiles
				.first()
				.getByText(/recount-compute/)
				.first(),
		).toBeVisible();
		await expect(lower.getByRole("img", { name: "Insight chart" })).toHaveCount(
			0,
		);
		await lower.scrollIntoViewIfNeeded();
		await expect(
			lower.getByRole("img", { name: "Insight chart" }),
		).toBeVisible();
		await page.setViewportSize({ width: 1440, height: 1600 });

		// Removing a tile keeps the insight; the list counts what remains.
		await page.getByRole("button", { name: "Actions for CPU now" }).click();
		await page.getByRole("menuitem", { name: "Remove from dashboard" }).click();
		await expect(tiles).toHaveCount(1);
		await page.getByRole("link", { name: "Back to dashboards" }).click();
		await expect(
			page.getByRole("row", { name: /Fleet health/ }).getByRole("cell", {
				name: "1",
				exact: true,
			}),
		).toBeVisible();
		// Anywhere on a dashboard's row opens it.
		const row = page.getByRole("row", { name: /Fleet health/ });
		const rowBox = await row.boundingBox();
		if (!rowBox) throw new Error("The row has no box");
		await row.click({
			position: { x: rowBox.width * 0.6, y: rowBox.height / 2 },
		});
		await expect(
			page.getByRole("heading", { name: "Fleet health", level: 1 }),
		).toBeVisible();
	} finally {
		await clickhouse.command({
			query:
				"ALTER TABLE telemetry.metric_points DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 1",
			query_params: { project: project.id },
		});
		await clickhouse.close();
	}
});

test("a tile's menu changes how it shows, overrides it and copies it", async ({
	page,
	workspace,
}) => {
	const actor = await workspace.signIn(
		page,
		`tile-menu-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Tiles",
				slug: `tiles-${randomUUID()}`,
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
	const reference = { organizationId: organization.id, projectId: project.id };
	const insight = data(
		await workspace.operations(actor.headers, (actor) =>
			saveInsight(workspace.database.db, actor, {
				...reference,
				insightId: randomUUID(),
				name: "CPU over time",
				draft: encodeDraft({
					...DEFAULT_DRAFT,
					series: [
						{
							...newSeries("A"),
							metric: "recount.node.cpu.time",
							calculation: "rate",
							combine: "sum",
						},
					],
				}),
			}),
		),
	);
	const fleet = { ...reference, dashboardId: randomUUID() };
	const archive = { ...reference, dashboardId: randomUUID() };
	await workspace.operations(actor.headers, async (actor) => {
		await saveDashboard(workspace.database.db, actor, {
			...fleet,
			name: "Fleet",
		});
		await saveDashboard(workspace.database.db, actor, {
			...archive,
			name: "Archive",
		});
		return addTiles(workspace.database.db, actor, {
			...fleet,
			insightIds: [insight.id],
		});
	});
	await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/dashboards/${fleet.dashboardId}`,
	);
	const menu = page.getByRole("button", { name: "Actions for CPU over time" });
	await expect(menu).toBeEnabled();

	// Display options save to the insight itself.
	await menu.click();
	await page.getByRole("menuitem", { name: "Display options" }).click();
	await page.getByRole("tab", { name: "Lines" }).click();
	await page.getByRole("switch", { name: "Show trend lines" }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Saving" }),
	).toBeHidden();
	await page.keyboard.press("Escape");
	await page.reload();
	await menu.click();
	await page.getByRole("menuitem", { name: "Display options" }).click();
	await page.getByRole("tab", { name: "Lines" }).click();
	await expect(
		page.getByRole("switch", { name: "Show trend lines" }),
	).toBeChecked();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	// A tile's own overrides show in its info, marked as the tile's.
	await menu.click();
	await page.getByRole("menuitem", { name: "Set overrides" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("combobox", { name: "Interval" }).click();
	await page.getByRole("option", { name: "1 hour" }).click();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("button", { name: "About CPU over time" }).hover();
	await expect(
		page.locator('[data-slot="hover-card-content"]').getByText("Tile", {
			exact: true,
		}),
	).toBeVisible();
	await page.mouse.move(0, 0);

	// Copying to another dashboard offers a link to it.
	await menu.click();
	await page.getByRole("menuitem", { name: "Copy to" }).click();
	await page.getByRole("option", { name: "Archive" }).click();
	const toast = page.getByText("Insight copied to");
	await expect(toast).toBeVisible();
	await page.getByRole("link", { name: "Archive" }).click();
	await expect(
		page.getByRole("heading", { name: "Archive", level: 1 }),
	).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(1);
});

test("a project opens on the dashboard chosen in its settings", async ({
	page,
	workspace,
}) => {
	const actor = await workspace.signIn(
		page,
		`home-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Home",
				slug: `home-${randomUUID()}`,
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
	const reference = { organizationId: organization.id, projectId: project.id };
	await workspace.operations(actor.headers, (actor) =>
		saveDashboard(workspace.database.db, actor, {
			...reference,
			dashboardId: randomUUID(),
			name: "Operations",
		}),
	);
	const home = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	await page.goto(home);
	await expect(
		page.getByRole("heading", { name: "Overview", level: 1 }),
	).toBeVisible();

	await page.goto(
		workspace.origin + settingsPath("project-customization", reference),
	);
	const choice = page.getByRole("combobox", { name: "Opens on" });
	await expect(choice).toHaveText("Overview");
	await choice.click();
	await page.getByRole("option", { name: "Operations" }).click();
	await expect(choice).toHaveText("Operations");

	await page.getByRole("link", { name: "Overview", exact: true }).click();
	await expect(page).toHaveURL(home);
	await expect(
		page.getByRole("heading", { name: "Operations", level: 1 }),
	).toBeVisible();
});
