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
import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { taskQueue } from "../../lib/task-queue";
import { cn } from "../../lib/utils";
import type { ProjectReference } from "../../organizations/contracts";
import type { DashboardFilters } from "../dashboard-filters";
import {
	type DashboardTile,
	HEIGHT_PRESETS,
	type TileHeight,
	type TileWidth,
	WIDTH_PRESETS,
} from "../dashboards";
import type { InsightDraft } from "../insight/draft";
import { ClickSensor } from "./click-sensor";
import {
	DashboardTileCard,
	TILE_COLUMN_CLASS,
	TILE_HEIGHT_CLASS,
	TILE_WIDTH_CLASS,
} from "./dashboard-tile";
import {
	fittedColumn,
	type TilePreview,
	TileResizeHandle,
	type TileSize,
} from "./tile-resize";

const WIDTH_LABEL: Record<(typeof WIDTH_PRESETS)[number], () => string> = {
	4: m.dashboard_width_third,
	6: m.dashboard_width_half,
	8: m.dashboard_width_two_thirds,
	12: m.dashboard_width_full,
};
const HEIGHT_LABEL: Record<(typeof HEIGHT_PRESETS)[number], () => string> = {
	1: m.dashboard_height_small,
	2: m.dashboard_height_medium,
	3: m.dashboard_height_large,
};
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
	onFetching: (tileId: string, fetching: boolean) => void;
}

/**
 * The dashboard's tiles on a 12-column grid. Members press a tile's header to pick it
 * up, drag or carry it with the button released, and click again to drop it, resize it from any side or corner, and do
 * either from its menu. The grid's cells show while a tile moves or resizes.
 */
export function DashboardGrid({
	tiles,
	onLayout,
	onRemove,
	...props
}: TileProps & {
	tiles: DashboardTile[];
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
							menu={
								<TileMenu
									tile={tile}
									reference={props.reference}
									canWrite={props.canWrite}
									disabled={props.disabled}
									first={position === 0}
									last={position === tiles.length - 1}
									onMove={(offset) => move(position, position + offset)}
									onResize={(size) => resize(tile, size)}
									onRemove={() => onRemove(tile)}
								/>
							}
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
	canWrite,
	disabled,
	onResizing,
	onResize,
	...props
}: TileProps & {
	tile: DashboardTile;
	menu: React.ReactNode;
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

function TileMenu({
	tile,
	reference,
	canWrite,
	disabled,
	first,
	last,
	onMove,
	onResize,
	onRemove,
}: {
	tile: DashboardTile;
	reference: ProjectReference;
	canWrite: boolean;
	disabled: boolean;
	first: boolean;
	last: boolean;
	onMove: (offset: number) => void;
	onResize: (size: Partial<DashboardTile>) => void;
	onRemove: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={m.dashboard_tile_actions({ name: tile.insight.name })}
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem asChild>
					<Link
						to="/organizations/$organizationId/projects/$projectId/insights/explore"
						params={reference}
						search={{ insight: tile.insight.id }}
					>
						{m.saved_open()}
					</Link>
				</DropdownMenuItem>
				{canWrite && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.dashboard_width()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuRadioGroup
									value={String(tile.width)}
									onValueChange={(value) =>
										onResize({
											width: Number(value) as TileWidth,
											column: fittedColumn(
												Number(value) as TileWidth,
												tile.column,
											),
										})
									}
								>
									{WIDTH_PRESETS.map((width) => (
										<DropdownMenuRadioItem key={width} value={String(width)}>
											{WIDTH_LABEL[width]()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger disabled={disabled}>
								{m.dashboard_height()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<DropdownMenuRadioGroup
									value={String(tile.height)}
									onValueChange={(value) =>
										onResize({ height: Number(value) as TileHeight })
									}
								>
									{HEIGHT_PRESETS.map((height) => (
										<DropdownMenuRadioItem key={height} value={String(height)}>
											{HEIGHT_LABEL[height]()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem
							disabled={disabled || first}
							onSelect={() => onMove(-1)}
						>
							{m.dashboard_move_earlier()}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={disabled || last}
							onSelect={() => onMove(1)}
						>
							{m.dashboard_move_later()}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							disabled={disabled}
							onSelect={onRemove}
						>
							{m.dashboard_remove_tile()}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
