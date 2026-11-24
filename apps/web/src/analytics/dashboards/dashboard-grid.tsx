import { useMemo } from "react";
import type { taskQueue } from "../../lib/task-queue";
import type { ProjectReference } from "../../organizations/contracts";
import type { DashboardFilters, TileOverrides } from "../dashboard-filters";
import { type DashboardTile, GRID_COLUMNS } from "../dashboards";
import type { InsightDraft } from "../insight/draft";
import { dashboardCompactor } from "./dashboard-grid-compaction";
import { DashboardGridLayout } from "./dashboard-grid-layout";
import { DashboardTileCard, TILE_HEIGHT_CLASS } from "./dashboard-tile";
import { dashboardLayout, tilesFromLayout } from "./grid-placement";
import { type TileActions, TileMenu } from "./tile-menu";

export type PageTileActions = Omit<
	TileActions,
	"onMove" | "onResize" | "onRemove"
>;

export function DashboardGrid({
	tiles,
	dashboardId,
	savingTile,
	overridden,
	actionsFor,
	onLayout,
	onRemove,
	draftOf,
	overridesOf,
	canWrite,
	disabled,
	unavailable,
	...card
}: {
	tiles: DashboardTile[];
	dashboardId: string;
	savingTile: string | null;
	overridden: (tile: DashboardTile) => boolean;
	actionsFor: (tile: DashboardTile) => PageTileActions;
	onLayout: (tiles: DashboardTile[]) => void;
	onRemove: (tile: DashboardTile) => void;
	draftOf: (tile: DashboardTile) => InsightDraft;
	overridesOf: (tile: DashboardTile) => TileOverrides;
	canWrite: boolean;
	disabled: boolean;
	unavailable?: string[];
	userId: string;
	reference: ProjectReference;
	now: Date;
	queue: ReturnType<typeof taskQueue>;
	nodeNames: Map<string, string>;
	filters: DashboardFilters;
	onFetching: (tileId: string, fetching: boolean) => void;
	onZoom: (from: Date, to: Date) => void;
	preview?: boolean;
}) {
	const layout = useMemo(() => dashboardLayout(tiles), [tiles]);
	const commit = (next: typeof layout) => {
		const placed = tilesFromLayout(tiles, layout, next);
		if (placed !== tiles) onLayout(placed);
	};
	const move = (from: number, offset: number) => {
		const source = layout[from];
		const target = layout[from + offset];
		if (!source || !target || source === target) return;
		const next = layout.map((item) => {
			let position = item;
			if (item === source) position = target;
			if (item === target) position = source;
			return {
				...item,
				x: Math.min(position.x, GRID_COLUMNS - item.w),
				y: position.y,
			};
		});
		commit(dashboardCompactor(() => null).compact(next, GRID_COLUMNS));
	};
	return (
		<DashboardGridLayout
			layout={layout}
			disabled={!canWrite || disabled || !!card.preview}
			onLayout={commit}
		>
			{tiles.map((tile, index) => (
				<div
					key={tile.id}
					data-dashboard-tile={tile.id}
					className={TILE_HEIGHT_CLASS[tile.height]}
				>
					<DashboardTileCard
						{...card}
						className="h-full"
						tile={tile}
						draft={draftOf(tile)}
						overrides={overridesOf(tile)}
						unavailable={unavailable?.includes(tile.id)}
						menu={(tools) =>
							!card.preview && (
								<TileMenu
									tile={tile}
									tools={tools}
									userId={card.userId}
									reference={card.reference}
									dashboardId={dashboardId}
									canWrite={canWrite}
									disabled={disabled}
									overridden={overridden(tile)}
									shownDraft={draftOf(tile)}
									first={index === 0}
									last={index === tiles.length - 1}
									savingDisplay={savingTile === tile.id}
									actions={{
										...actionsFor(tile),
										onMove: (offset) => move(index, offset),
										onResize: (size) =>
											onLayout(
												tiles.map((other) =>
													other.id === tile.id ? { ...other, ...size } : other,
												),
											),
										onRemove: () => onRemove(tile),
									}}
								/>
							)
						}
					/>
				</div>
			))}
		</DashboardGridLayout>
	);
}
