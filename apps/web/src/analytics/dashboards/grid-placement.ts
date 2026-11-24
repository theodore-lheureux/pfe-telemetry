import type { Layout, LayoutItem } from "react-grid-layout";
import {
	type DashboardTile,
	GRID_COLUMNS,
	TILE_HEIGHTS,
	TILE_WIDTHS,
} from "../dashboards";

export type TileSize = Pick<DashboardTile, "width" | "height" | "column">;

export function fittedColumn(
	width: TileSize["width"],
	column: TileSize["column"],
) {
	return column === null ? null : Math.min(column, GRID_COLUMNS - width + 1);
}

export function dashboardLayout(tiles: readonly DashboardTile[]): Layout {
	const bottoms = Array<number>(GRID_COLUMNS).fill(0);
	const row = (x: number, w: number) => Math.max(...bottoms.slice(x, x + w));
	return tiles.map(({ id, width: w, height, column }) => {
		const h = height + 1;
		let x = column === null ? 0 : column - 1;
		let y = row(x, w);
		if (column === null) {
			for (let i = 1; i <= GRID_COLUMNS - w && y > 0; i++) {
				const candidate = row(i, w);
				if (candidate >= y) continue;
				x = i;
				y = candidate;
			}
		}
		bottoms.fill(y + h, x, x + w);
		return {
			i: id,
			x,
			y,
			w,
			h,
			minW: TILE_WIDTHS[0],
			maxH: TILE_HEIGHTS.length,
		};
	});
}

/** For an upward-packed grid, reading order and start columns encode every row. */
export function tilesFromLayout(
	tiles: DashboardTile[],
	before: Layout,
	after: Layout,
) {
	const original = new Map(before.map((item) => [item.i, item]));
	const byId = new Map(tiles.map((tile) => [tile.id, tile]));
	const sorted = [...after].sort((a, b) => a.y - b.y || a.x - b.x);
	const changed = (item: LayoutItem) => {
		const old = original.get(item.i);
		return (
			!old ||
			old.x !== item.x ||
			old.y !== item.y ||
			old.w !== item.w ||
			old.h !== item.h
		);
	};
	if (!sorted.some(changed)) return tiles;
	return sorted.map(({ i, x, w, h }) => {
		const tile = byId.get(i);
		if (!tile) throw new Error("Grid item has no dashboard tile");
		return {
			...tile,
			column: x + 1,
			width: w as TileSize["width"],
			height: (h - 1) as TileSize["height"],
		};
	});
}
