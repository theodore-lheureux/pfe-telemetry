import {
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	pointerWithin,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState } from "react";
import type { taskQueue } from "../../lib/task-queue";
import { cn } from "../../lib/utils";
import type { ProjectReference } from "../../organizations/contracts";
import type { DashboardFilters, TileOverrides } from "../dashboard-filters";
import type { DashboardTile } from "../dashboards";
import type { InsightDraft } from "../insight/draft";
import { ClickSensor } from "./click-sensor";
import {
	DashboardTileCard,
	TILE_COLUMN_CLASS,
	TILE_HEIGHT_CLASS,
	TILE_WIDTH_CLASS,
} from "./dashboard-tile";
import { type TileActions, TileMenu, type TileTools } from "./tile-menu";
import {
	type TilePreview,
	TileResizeHandle,
	type TileSize,
} from "./tile-resize";

/**
 * The tile under the pointer, since a tile is carried by its header and its centre can
 * be far from where it is pointed; the nearest one when the pointer is between tiles.
 */
const underPointer: CollisionDetection = (args) => {
	const hits = pointerWithin(args);
	return hits.length ? hits : closestCenter(args);
};
// Dense packing lets later tiles fill the room before a tile with a start column.
const GRID =
	"grid grid-flow-row-dense auto-rows-[8rem] grid-cols-1 gap-4 lg:grid-cols-12";

interface TileProps {
	userId: string;
	reference: ProjectReference;
	now: Date;
	queue: ReturnType<typeof taskQueue>;
	nodeNames: Map<string, string>;
	canWrite: boolean;
	disabled: boolean;
	draftOf: (tile: DashboardTile) => InsightDraft;
	filters: DashboardFilters;
	overridesOf: (tile: DashboardTile) => TileOverrides;
	onFetching: (tileId: string, fetching: boolean) => void;
	onZoom: (from: Date, to: Date) => void;
}

/** The menu actions the page handles for a tile; moves and sizes stay in the grid. */
export type PageTileActions = Omit<
	TileActions,
	"onMove" | "onResize" | "onRemove"
>;

/**
 * The dashboard's tiles on a 12-column grid. Members press a tile's header to pick it
 * up, drag or carry it with the button released, and click again to drop it; they
 * resize it from its sides and bottom corners. Its menu offers both and more. The
 * grid's cells show while a tile moves or resizes.
 */
export function DashboardGrid({
	tiles,
	dashboardId,
	savingTile,
	overridden,
	actionsFor,
	onLayout,
	onRemove,
	...props
}: TileProps & {
	tiles: DashboardTile[];
	dashboardId: string;
	/** The tile whose insight is being saved, if any. */
	savingTile: string | null;
	overridden: (tile: DashboardTile) => boolean;
	actionsFor: (tile: DashboardTile) => PageTileActions;
	onLayout: (tiles: DashboardTile[]) => void;
	onRemove: (tile: DashboardTile) => void;
}) {
	const sensors = useSensors(useSensor(ClickSensor));
	const grid = useRef<HTMLDivElement>(null);
	// Rows of guide cells, while a tile moves or resizes; enough to grow into.
	const [guides, setGuides] = useState(0);
	const showGuides = (show: boolean) => {
		const element = grid.current;
		if (!show || !element) return setGuides(0);
		const style = getComputedStyle(element);
		const gap = Number.parseFloat(style.rowGap) || 0;
		const row = Number.parseFloat(style.gridAutoRows) + gap;
		setGuides(Math.ceil((element.offsetHeight + gap) / row) + 4);
	};
	const index = (id: unknown) => tiles.findIndex((tile) => tile.id === id);
	const move = (from: number, to: number) => {
		if (from === to || to < 0 || to >= tiles.length) return;
		// A moved tile goes where it was dropped, not back to a start column it had.
		onLayout(
			arrayMove(tiles, from, to).map((tile, index) =>
				index === to ? { ...tile, column: null } : tile,
			),
		);
	};
	const resize = (tile: DashboardTile, size: Partial<DashboardTile>) =>
		onLayout(
			tiles.map((other) =>
				other.id === tile.id ? { ...other, ...size } : other,
			),
		);
	const dragged = ({ active, over }: DragEndEvent) => {
		showGuides(false);
		if (over) move(index(active.id), index(over.id));
	};
	return (
		<DndContext
			sensors={sensors}
			collisionDetection={underPointer}
			onDragStart={() => showGuides(true)}
			onDragEnd={dragged}
			onDragCancel={() => showGuides(false)}
		>
			<SortableContext items={tiles} strategy={rectSortingStrategy}>
				<div ref={grid} data-dashboard-grid className={cn("relative", GRID)}>
					{guides > 0 && (
						<div
							aria-hidden="true"
							className={cn("pointer-events-none absolute inset-0", GRID)}
						>
							{Array.from({ length: guides * 12 }, (_, cell) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: identical, fixed cells.
									key={cell}
									className="rounded-md border border-dashed border-primary/25 bg-primary/[0.03]"
								/>
							))}
						</div>
					)}
					{tiles.map((tile, position) => (
						<SortableTile
							key={tile.id}
							tile={tile}
							{...props}
							onResizing={showGuides}
							onResize={(size) => resize(tile, size)}
							menu={(tools) => (
								<TileMenu
									tile={tile}
									tools={tools}
									userId={props.userId}
									reference={props.reference}
									dashboardId={dashboardId}
									canWrite={props.canWrite}
									disabled={props.disabled}
									overridden={overridden(tile)}
									shownDraft={props.draftOf(tile)}
									first={position === 0}
									last={position === tiles.length - 1}
									savingDisplay={savingTile === tile.id}
									actions={{
										...actionsFor(tile),
										onMove: (offset) => move(position, position + offset),
										onResize: (size) => resize(tile, size),
										onRemove: () => onRemove(tile),
									}}
								/>
							)}
						/>
					))}
				</div>
			</SortableContext>
		</DndContext>
	);
}

/**
 * One grid cell holding a tile. While the tile resizes, the cell takes the size it will
 * snap to, outlined, and the tile follows the pointer above it.
 */
function SortableTile({
	tile,
	menu,
	draftOf,
	overridesOf,
	canWrite,
	disabled,
	onResizing,
	onResize,
	...props
}: TileProps & {
	tile: DashboardTile;
	menu: (tools: TileTools) => React.ReactNode;
	onResizing: (resizing: boolean) => void;
	onResize: (size: TileSize) => void;
}) {
	const sortable = useSortable({
		id: tile.id,
		disabled: !canWrite || disabled,
	});
	const [preview, setPreview] = useState<TilePreview | null>(null);
	const size = preview?.size ?? tile;
	return (
		<div
			ref={sortable.setNodeRef}
			style={{
				transform: CSS.Translate.toString(sortable.transform),
				transition: sortable.transition,
			}}
			className={cn(
				"group/tile relative min-w-0 rounded-lg",
				TILE_WIDTH_CLASS[size.width],
				TILE_HEIGHT_CLASS[size.height],
				size.column !== null && TILE_COLUMN_CLASS[size.column],
				(sortable.isDragging || preview) && "z-20",
				preview && "bg-primary/10 outline-2 outline-primary/60 outline-dashed",
			)}
		>
			<DashboardTileCard
				className={cn(
					preview && "absolute top-0 shadow-lg",
					preview?.anchor === "right" && "right-0",
					preview?.anchor === "left" && "left-0",
					!preview && "h-full",
					sortable.isDragging && "shadow-lg ring-2 ring-primary",
				)}
				style={
					preview ? { width: preview.width, height: preview.height } : undefined
				}
				tile={tile}
				draft={draftOf(tile)}
				overrides={overridesOf(tile)}
				{...props}
				header={
					canWrite && !disabled
						? {
								...sortable.listeners,
								className: cn(
									"cursor-grab select-none",
									sortable.isDragging && "cursor-grabbing",
								),
							}
						: undefined
				}
				menu={menu}
				resizer={
					canWrite && (
						<TileResizeHandle
							tile={tile}
							disabled={disabled}
							onPreview={(next) => {
								if (!next !== !preview) onResizing(!!next);
								setPreview(next);
							}}
							onResize={onResize}
						/>
					)
				}
			/>
		</div>
	);
}
