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

test("mixed-size dashboard tiles follow the pointer and save their compacted layout", async ({
	page,
	workspace,
}) => {
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
		small.locator("..").getByRole("button", { name: /^Drag to resize/ }),
	).toBeEnabled();
	const header = small.locator("header");
	const headerBox = await header.boundingBox();
	const original = await small.boundingBox();
	const destination = await wide.boundingBox();
	if (!headerBox || !original || !destination)
		throw new Error("Missing tile bounds");
	const startX = headerBox.x + headerBox.width * 0.5;
	const y = headerBox.y + 10;
	await page.mouse.move(startX, y);
	await page.mouse.down();
	await page.mouse.move(destination.x + headerBox.width * 0.5, y, {
		steps: 10,
	});
	const placeholder = page.locator("[data-drop-placeholder]");
	await expect(placeholder).toBeVisible();
	await expect(placeholder.locator("rect")).toHaveCount(2);
	const carried = await small.boundingBox();
	const highlighted = await placeholder.boundingBox();
	if (!carried || !highlighted) throw new Error("Missing drag bounds");
	await page.mouse.move(destination.x + headerBox.width * 0.5 + 10, y);
	await expect
		.poll(async () => (await small.boundingBox())?.x)
		.toBeCloseTo(carried.x + 10, 0);
	await expect
		.poll(async () => (await placeholder.boundingBox())?.x)
		.toBeCloseTo(highlighted.x, 0);
	await page.mouse.up();
	await expect(placeholder).toHaveCount(0);
	await expect(page.getByText("Changes saved")).toBeVisible();
	await expect
		.poll(async () => (await small.boundingBox())?.x)
		.toBeCloseTo(highlighted.x, 0);
	const resize = small
		.locator("..")
		.getByRole("button", { name: /^Drag to resize/ });
	await expect(resize).toBeEnabled();
	await page.keyboard.press("ControlOrMeta+z");
	await expect
		.poll(async () => (await small.boundingBox())?.x)
		.toBeCloseTo(original.x, 0);
	await expect(resize).toBeEnabled();
	await page.keyboard.press("ControlOrMeta+Shift+z");
	await expect
		.poll(async () => (await small.boundingBox())?.x)
		.toBeCloseTo(highlighted.x, 0);
	await expect(resize).toBeEnabled();
	await resize.press("ArrowDown");
	await expect
		.poll(async () => (await small.boundingBox())?.height)
		.toBeCloseTo(carried.height + 144, 0);
	await expect(resize).toBeEnabled();
	await page.reload();
	await expect(resize).toBeEnabled();
	await expect
		.poll(async () => (await small.boundingBox())?.x)
		.toBeCloseTo(highlighted.x, 0);
	await expect
		.poll(async () => (await small.boundingBox())?.height)
		.toBeCloseTo(carried.height + 144, 0);
});
