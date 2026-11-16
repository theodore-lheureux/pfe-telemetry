import { expect, test } from "bun:test";
import type { DashboardTile } from "../../src/analytics/dashboards";
import { moveDashboardTile } from "../../src/analytics/dashboards/grid-placement";

test("drop preview and committed order clear only the moved tile's start column", () => {
	const tiles = [
		{ id: "wide", width: 12, height: 3, column: null },
		{ id: "small", width: 2, height: 0, column: 11 },
		{ id: "anchored", width: 4, height: 2, column: 5 },
	] as DashboardTile[];
	const next = moveDashboardTile(tiles, 1, 0);
	expect(next.map((tile) => tile.id)).toEqual(["small", "wide", "anchored"]);
	expect(next[0]).toMatchObject({ width: 2, height: 0, column: null });
	expect(next[2]).toBe(tiles[2]);
	expect(tiles[1].column).toBe(11);
	expect(moveDashboardTile(tiles, 1, 1)).toBe(tiles);
	expect(moveDashboardTile(tiles, -1, 0)).toBe(tiles);
});
