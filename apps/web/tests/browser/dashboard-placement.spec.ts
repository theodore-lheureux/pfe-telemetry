import { randomUUID } from "node:crypto";
import {
	addTiles,
	saveDashboard,
	updateLayout,
} from "../../src/analytics/dashboards.server";
import {
	DEFAULT_DRAFT,
	encodeDraft,
	newSeries,
} from "../../src/analytics/insight/draft";
import { saveInsight } from "../../src/analytics/saved-insights.server";
import { createOrganization } from "../../src/organizations/organizations.server";
import { createProject } from "../../src/organizations/projects.server";
import { data, expect, test } from "./fixtures";

test("mixed-size dashboard tiles land exactly in their preview and cancel without changing layout", async ({
	page,
	workspace,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1400 });
	const actor = await workspace.signIn(
		page,
		`placement-${randomUUID()}@example.invalid`,
	);
	const organization = data(
		await workspace.operations(actor.headers, () =>
			createOrganization(workspace.auth, actor.headers, {
				name: "Placement",
				slug: `placement-${randomUUID()}`,
			}),
		),
	);
	const project = data(
		await workspace.operations(actor.headers, (actor) =>
			createProject(workspace.database.db, actor, {
				requestId: randomUUID(),
				organizationId: organization.id,
				name: "Placement",
			}),
		),
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const insightIds: string[] = [];
	for (const name of ["Wide", "Small", "Anchored", "Tall"]) {
		const insight = data(
			await workspace.operations(actor.headers, (actor) =>
				saveInsight(workspace.database.db, actor, {
					...reference,
					insightId: randomUUID(),
					name,
					draft: encodeDraft({
						...DEFAULT_DRAFT,
						series: [{ ...newSeries("A"), metric: "test.placement" }],
					}),
				}),
			),
		);
		insightIds.push(insight.id);
	}
	const target = { ...reference, dashboardId: randomUUID() };
	data(
		await workspace.operations(actor.headers, (actor) =>
			saveDashboard(workspace.database.db, actor, {
				...target,
				name: "Placement",
			}),
		),
	);
	const added = data(
		await workspace.operations(actor.headers, (actor) =>
			addTiles(workspace.database.db, actor, { ...target, insightIds }),
		),
	);
	const sizes = [
		{ width: 8 as const, height: 3 as const, column: null },
		{ width: 2 as const, height: 0 as const, column: 11 },
		{ width: 4 as const, height: 1 as const, column: 1 },
		{ width: 3 as const, height: 2 as const, column: null },
	];
	data(
		await workspace.operations(actor.headers, (actor) =>
			updateLayout(workspace.database.db, actor, {
				...target,
				tiles: added.tiles.map((tile, index) => ({
					id: tile.id,
					...sizes[index],
				})),
			}),
		),
	);
	await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/dashboards/${target.dashboardId}`,
	);
	const small = page.getByRole("article", { name: "Small", exact: true });
	const wide = page.getByRole("article", { name: "Wide", exact: true });
	await expect(small).toBeVisible();
	await expect(page.locator("[data-dashboard-tile]")).toHaveCount(4);
	await expect(
		page.getByRole("button", { name: "Resize Small", exact: true }),
	).toBeEnabled();
	const header = small.locator("header");
	const headerBox = await header.boundingBox();
	const destination = await wide.boundingBox();
	if (!headerBox || !destination) throw new Error("Missing tile bounds");
	await header.click({ position: { x: headerBox.width * 0.6, y: 10 } });
	const x = destination.x + destination.width / 4;
	const y = destination.y + destination.height / 2;
	await page.mouse.move(x, y, { steps: 10 });
	const placeholder = page.locator("[data-drop-placeholder]");
	await expect(placeholder).toBeVisible();
	const predicted = await page
		.locator("[data-placement-tile]")
		.evaluateAll((nodes) =>
			nodes.map((node) => {
				const rect = node.getBoundingClientRect();
				return {
					id: node.getAttribute("data-placement-tile"),
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
				};
			}),
		);
	const placementError = async (exclude?: string | null) => {
		const actual = await page
			.locator("[data-dashboard-tile]")
			.evaluateAll((nodes) =>
				nodes.map((node) => {
					const rect = node.getBoundingClientRect();
					return {
						id: node.getAttribute("data-dashboard-tile"),
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height,
					};
				}),
			);
		return Math.max(
			...predicted.flatMap((expected) => {
				if (expected.id === exclude) return [];
				const tile = actual.find((tile) => tile.id === expected.id);
				if (!tile) return [Number.POSITIVE_INFINITY];
				return (["x", "y", "width", "height"] as const).map((key) =>
					Math.abs(tile[key] - expected[key]),
				);
			}),
		);
	};
	const activeId = await placeholder.getAttribute("data-drop-placeholder");
	await expect.poll(() => placementError(activeId)).toBeLessThan(1);
	await page.screenshot({ path: testInfo.outputPath("placement-preview.png") });
	await page.mouse.click(x, y);
	await expect(placeholder).toHaveCount(0);
	await expect(page.locator("[data-dashboard-tile]").first()).toContainText(
		"Small",
	);
	await expect.poll(() => placementError()).toBeLessThan(1);
	await expect(
		page.getByRole("button", { name: "Resize Small", exact: true }),
	).toBeEnabled();
	await header.click({ position: { x: headerBox.width * 0.6, y: 10 } });
	await page.mouse.move(
		destination.x + destination.width / 2,
		destination.y + destination.height,
		{ steps: 5 },
	);
	await expect(placeholder).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(placeholder).toHaveCount(0);
	await expect(page.locator("[data-dashboard-tile]").first()).toContainText(
		"Small",
	);
});
