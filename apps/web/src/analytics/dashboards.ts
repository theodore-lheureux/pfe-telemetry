import type { ProjectReference } from "../organizations/contracts";
import type { InsightPerson } from "./saved-insights";

export const MAX_DASHBOARD_NAME = 120;
export const MAX_DASHBOARD_DESCRIPTION = 1000;
export const MAX_DASHBOARD_TILES = 24;

export const GRID_COLUMNS = 12;
/** Columns of the 12-column grid a tile spans. */
export const TILE_WIDTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type TileWidth = (typeof TILE_WIDTHS)[number];
/** Widths offered by name in a tile's menu: a third, half, two thirds or all. */
export const WIDTH_PRESETS = [4, 6, 8, 12] as const;
/** Size steps of a tile's height; each spans one grid row more than the step. */
export const TILE_HEIGHTS = [1, 2, 3, 4, 5, 6] as const;
export type TileHeight = (typeof TILE_HEIGHTS)[number];
/** Heights offered by name in a tile's menu: small, medium or large. */
export const HEIGHT_PRESETS = [1, 2, 3] as const;
export const DEFAULT_TILE = { width: 6, height: 2 } as const;

export interface DashboardSummary {
	id: string;
	name: string;
	description: string;
	tileCount: number;
	createdAt: Date;
	/** Null when that account was deleted. */
	createdBy: InsightPerson | null;
	updatedAt: Date;
}

export interface DashboardTile {
	id: string;
	width: TileWidth;
	height: TileHeight;
	/** The first grid column, 1–12; null places the tile after the one before it. */
	column: number | null;
	insight: {
		id: string;
		name: string;
		description: string;
		draft: string;
		createdAt: Date;
		/** Null when that account was deleted. */
		createdBy: InsightPerson | null;
		updatedAt: Date;
		/** Null when that account was deleted. */
		updatedBy: InsightPerson | null;
	};
}

export interface Dashboard extends Omit<DashboardSummary, "tileCount"> {
	/** The overrides every tile uses, as `DashboardFilters` JSON. */
	filters: string;
	tiles: DashboardTile[];
}

export type DashboardReference = ProjectReference & { dashboardId: string };

export type SaveDashboardInput = DashboardReference & {
	name: string;
	/** Omitted to keep the stored description. */
	description?: string;
	/** `DashboardFilters` JSON; omitted to keep the stored overrides. */
	filters?: string;
};

export type AddTilesInput = DashboardReference & { insightIds: string[] };

/** Every tile of the dashboard in its new order, with its size. */
export type LayoutInput = DashboardReference & {
	tiles: Pick<DashboardTile, "id" | "width" | "height" | "column">[];
};

export type RemoveTileInput = DashboardReference & { tileId: string };
