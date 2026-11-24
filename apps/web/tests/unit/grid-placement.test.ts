import { expect, test } from "bun:test";
import type { DashboardTile } from "../../src/analytics/dashboards";
import { dashboardCompactor } from "../../src/analytics/dashboards/dashboard-grid-compaction";
import {
	dashboardLayout,
	tilesFromLayout,
} from "../../src/analytics/dashboards/grid-placement";

const tiles = [
	{ id: "wide", width: 8, height: 2, column: null },
	{ id: "side", width: 4, height: 1, column: null },
	{ id: "lower", width: 4, height: 0, column: null },
] as DashboardTile[];

test("a compacted layout survives serialization without changing the tile positions", () => {
	const before = dashboardLayout(tiles);
	const after = dashboardCompactor(() => null).compact(
		before.map((item) => (item.i === "wide" ? { ...item, x: 4 } : item)),
		12,
	);
	const saved = tilesFromLayout(tiles, before, after);
	const positions = (layout: typeof before) =>
		layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
	expect(positions(dashboardLayout(saved))).toEqual(positions(after));
	expect(tilesFromLayout(tiles, before, before)).toBe(tiles);
});

test("widening a tile can shrink its neighbor without changing rows", () => {
	const before = dashboardLayout(tiles);
	const after = dashboardCompactor(() => ({
		id: "wide",
		baseline: before,
	})).compact(
		before.map((item) => (item.i === "wide" ? { ...item, w: 9 } : item)),
		12,
	);
	expect(after.find(({ i }) => i === "side")).toMatchObject({
		x: 9,
		y: 0,
		w: 3,
	});
});
