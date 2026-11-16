import { m } from "@recount/i18n/messages";
import {
	type KeyboardEvent,
	type PointerEvent,
	useId,
	useRef,
	useState,
} from "react";
import { cn } from "../../lib/utils";
import {
	type DashboardTile,
	GRID_COLUMNS,
	TILE_HEIGHTS,
	TILE_WIDTHS,
	type TileHeight,
	type TileWidth,
} from "../dashboards";

export type TileSize = Pick<DashboardTile, "width" | "height" | "column">;
/** A resize in progress: the pointer's size in pixels and the size it snaps to. */
export interface TilePreview {
	size: TileSize;
	width: number;
	height: number;
	/** The side that stays put: the right one while the left side is dragged. */
	anchor: "left" | "right";
}

/** Grid rows a tile spans at a height, matching `TILE_HEIGHT_CLASS`. */
const rowSpan = (height: TileHeight) => height + 1;
const MIN_WIDTH = TILE_WIDTHS[0];
const MAX_HEIGHT = TILE_HEIGHTS[TILE_HEIGHTS.length - 1];

/** A width that fits the row from the tile's start column, when it has one. */
export function fittedColumn(
	width: TileWidth,
	column: number | null,
): TileSize["column"] {
	if (column === null) return null;
	return Math.min(column, GRID_COLUMNS - width + 1);
}

/** The option whose measure, in grid tracks, is closest to the dragged size. */
function nearest<T extends number>(
	options: readonly T[],
	target: number,
	tracks: (option: T) => number = (option) => option,
) {
	return options.reduce((best, option) =>
		Math.abs(tracks(option) - target) < Math.abs(tracks(best) - target)
			? option
			: best,
	);
}

function step<T extends number>(options: readonly T[], current: T, by: number) {
	const index = options.indexOf(current) + by;
	return options[Math.max(0, Math.min(options.length - 1, index))] as T;
}

/** Which way a side or corner moves: -1 for left, 1 for right or bottom. */
type Direction = { x: -1 | 0 | 1; y: 0 | 1 };

/**
 * The sides and corners the pointer can drag; the bottom-right corner is the handle.
 * Rows come from the order of the tiles, so the top side cannot move and has none.
 */
const EDGES: { direction: Direction; className: string }[] = [
	{
		direction: { x: 0, y: 1 },
		className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize",
	},
	{
		direction: { x: -1, y: 0 },
		className: "inset-y-3 left-0 w-1.5 cursor-ew-resize",
	},
	{
		direction: { x: 1, y: 0 },
		className: "inset-y-3 right-0 w-1.5 cursor-ew-resize",
	},
	{
		direction: { x: -1, y: 1 },
		className: "bottom-0 left-0 size-3 cursor-nesw-resize",
	},
];

interface Drag {
	direction: Direction;
	pointerX: number;
	pointerY: number;
	width: number;
	height: number;
	/** One column's width, gap included. */
	step: number;
	row: number;
	gapX: number;
	gapY: number;
	/** The columns the tile starts and ends in, as placed now. */
	first: number;
	last: number;
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/**
 * Resizes a tile from its sides and bottom corners. The tile follows the pointer while
 * the size it will snap to is shown beneath it, and that size is saved on release.
 * Dragging the left side keeps the right one in place by setting the start column; a
 * tile grows only to the end of its row. The visible bottom-right handle also takes
 * the arrow keys, which step through the sizes and save each one.
 */
export function TileResizeHandle({
	tile,
	disabled,
	onPreview,
	onResize,
}: {
	tile: DashboardTile;
	disabled: boolean;
	onPreview: (preview: TilePreview | null) => void;
	onResize: (size: TileSize) => void;
}) {
	const id = useId();
	const drag = useRef<Drag | null>(null);
	const preview = useRef<TileSize | null>(null);
	const [dragging, setDragging] = useState(false);
	const measure = (
		event: PointerEvent<HTMLElement>,
		direction: Direction,
	): Drag | null => {
		const card = event.currentTarget.closest("article");
		const grid = card?.closest("[data-dashboard-grid]");
		if (!card || !grid) return null;
		const style = getComputedStyle(grid);
		const gapX = Number.parseFloat(style.columnGap) || 0,
			gapY = Number.parseFloat(style.rowGap) || 0;
		const rect = card.getBoundingClientRect();
		const step =
			(grid.clientWidth - (GRID_COLUMNS - 1) * gapX) / GRID_COLUMNS + gapX;
		const first =
			tile.column ??
			Math.round((rect.left - grid.getBoundingClientRect().left) / step) + 1;
		return {
			direction,
			pointerX: event.clientX,
			pointerY: event.clientY,
			width: rect.width,
			height: rect.height,
			step,
			row: Number.parseFloat(style.gridAutoRows) + gapY,
			gapX,
			gapY,
			first,
			last: first + tile.width - 1,
		};
	};
	const end = (commit: boolean) => {
		const size = preview.current;
		drag.current = null;
		preview.current = null;
		setDragging(false);
		onPreview(null);
		if (
			commit &&
			size &&
			(size.width !== tile.width ||
				size.height !== tile.height ||
				size.column !== tile.column)
		)
			onResize(size);
	};
	const dragFrom = (direction: Direction) => ({
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			if (disabled || event.button !== 0) return;
			event.preventDefault();
			drag.current = measure(event, direction);
			if (!drag.current) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			setDragging(true);
		},
		onPointerMove: (event: PointerEvent<HTMLElement>) => {
			const start = drag.current;
			if (!start) return;
			const { x, y } = start.direction;
			const px = (columns: number) => columns * start.step - start.gapX;
			// The columns the dragged side can reach: to the row's end, or its start.
			const room = x < 0 ? start.last : GRID_COLUMNS - start.first + 1;
			const width = x
				? clamp(
						start.width + x * (event.clientX - start.pointerX),
						px(MIN_WIDTH),
						px(room),
					)
				: start.width;
			const height = y
				? clamp(
						start.height + (event.clientY - start.pointerY),
						rowSpan(TILE_HEIGHTS[0]) * start.row - start.gapY,
						rowSpan(MAX_HEIGHT) * start.row - start.gapY,
					)
				: start.height;
			const columns = x
				? nearest<TileWidth>(
						TILE_WIDTHS.filter((option) => option <= room),
						(width + start.gapX) / start.step,
					)
				: tile.width;
			const size: TileSize = {
				width: columns,
				height: y
					? nearest<TileHeight>(
							TILE_HEIGHTS,
							(height + start.gapY) / start.row,
							rowSpan,
						)
					: tile.height,
				column: x < 0 ? start.last - columns + 1 : tile.column,
			};
			preview.current = size;
			onPreview({ size, width, height, anchor: x < 0 ? "right" : "left" });
		},
		onPointerUp: () => end(true),
		onPointerCancel: () => end(false),
	});
	const keyed = (event: KeyboardEvent) => {
		const widen = (by: number) => {
			const width = step(TILE_WIDTHS, tile.width, by);
			return {
				width,
				height: tile.height,
				column: fittedColumn(width, tile.column),
			};
		};
		const heighten = (by: number) => ({
			width: tile.width,
			height: step(TILE_HEIGHTS, tile.height, by),
			column: tile.column,
		});
		const sizes: Record<string, TileSize> = {
			ArrowLeft: widen(-1),
			ArrowRight: widen(1),
			ArrowUp: heighten(-1),
			ArrowDown: heighten(1),
		};
		const size = sizes[event.key];
		if (!size) return;
		event.preventDefault();
		if (disabled) return;
		if (
			size.width !== tile.width ||
			size.height !== tile.height ||
			size.column !== tile.column
		)
			onResize(size);
	};
	return (
		<>
			{EDGES.map(({ direction, className }) => (
				// Pointer-only targets; the handle below offers the same resizing by keyboard.
				<div
					key={`${direction.x}${direction.y}`}
					aria-hidden="true"
					className={cn(
						"absolute z-10 hidden touch-none lg:block",
						className,
						disabled && "cursor-default",
					)}
					{...dragFrom(direction)}
				/>
			))}
			<button
				type="button"
				// Stays focusable while a change saves, so arrow presses can follow each other.
				aria-disabled={disabled}
				aria-label={m.dashboard_resize_tile({ name: tile.insight.name })}
				aria-describedby={`${id}-instructions`}
				title={m.dashboard_resize_tile({ name: tile.insight.name })}
				// Shown while the tile is hovered or the handle is focused or dragged.
				className={cn(
					"absolute right-0.5 bottom-0.5 z-10 hidden size-5 cursor-nwse-resize touch-none items-end justify-end rounded-sm p-1 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset group-hover/tile:opacity-100 aria-disabled:cursor-default aria-disabled:group-hover/tile:opacity-40 lg:flex",
					dragging && "text-foreground opacity-100",
				)}
				{...dragFrom({ x: 1, y: 1 })}
				onKeyDown={keyed}
			>
				<svg
					aria-hidden="true"
					viewBox="0 0 10 10"
					className="size-2.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.25"
					strokeLinecap="round"
				>
					<path d="M9 1 1 9M9 5 5 9" />
				</svg>
			</button>
			<span id={`${id}-instructions`} hidden>
				{m.dashboard_resize_instructions()}
			</span>
		</>
	);
}
