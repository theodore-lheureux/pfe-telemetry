import type {
	DragOverEvent,
	DragStartEvent,
	UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, type SortingStrategy } from "@dnd-kit/sortable";
import {
	type RefObject,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "../../lib/utils";
import type { DashboardTile } from "../dashboards";
import {
	TILE_COLUMN_CLASS,
	TILE_HEIGHT_CLASS,
	TILE_WIDTH_CLASS,
} from "./dashboard-tile";

export function moveDashboardTile(
	tiles: DashboardTile[],
	from: number,
	to: number,
) {
	if (
		from === to ||
		from < 0 ||
		to < 0 ||
		from >= tiles.length ||
		to >= tiles.length
	)
		return tiles;
	return arrayMove(tiles, from, to).map((tile, index) =>
		index === to ? { ...tile, column: null } : tile,
	);
}

/**
 * Let CSS pack a lightweight copy of the proposed layout. Rectangle swapping cannot
 * predict dense placement when tiles span different numbers of rows and columns.
 */
export function useGridPlacement(
	tiles: DashboardTile[],
	grid: RefObject<HTMLDivElement | null>,
) {
	const [drag, setDrag] = useState<{
		active: UniqueIdentifier;
		over: UniqueIdentifier;
	} | null>(null);
	const mirror = useRef<HTMLDivElement>(null);
	const [positions, setPositions] = useState(
		new Map<string, { x: number; y: number }>(),
	);
	const order = useMemo(() => {
		if (!drag) return null;
		return moveDashboardTile(
			tiles,
			tiles.findIndex((tile) => tile.id === drag.active),
			tiles.findIndex((tile) => tile.id === drag.over),
		);
	}, [tiles, drag]);
	useLayoutEffect(() => {
		const element = mirror.current;
		if (!order || !element) return;
		const measure = () => {
			const next = new Map<string, { x: number; y: number }>();
			for (const child of element.children) {
				if (!(child instanceof HTMLElement) || !child.dataset.placementTile)
					continue;
				next.set(child.dataset.placementTile, {
					x: child.offsetLeft,
					y: child.offsetTop,
				});
			}
			setPositions(next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [order]);
	const strategy = useCallback<SortingStrategy>(
		({ rects, index }) => {
			if (!drag) return null;
			const tile = tiles[index];
			const target = tile && positions.get(tile.id);
			const rect = rects[index];
			const origin = grid.current?.getBoundingClientRect();
			if (!target || !rect || !origin) return null;
			return {
				x: origin.left + target.x - rect.left,
				y: origin.top + target.y - rect.top,
				scaleX: 1,
				scaleY: 1,
			};
		},
		[drag, tiles, positions, grid],
	);
	return {
		order,
		mirror,
		strategy,
		active: drag?.active,
		start: ({ active }: DragStartEvent) =>
			setDrag({ active: active.id, over: active.id }),
		over: ({ active, over }: DragOverEvent) =>
			setDrag({ active: active.id, over: over?.id ?? active.id }),
		clear: () => setDrag(null),
	};
}

export function GridPlacement({
	tiles,
	active,
	mirror,
	className,
}: {
	tiles: DashboardTile[];
	active: UniqueIdentifier | undefined;
	mirror: RefObject<HTMLDivElement | null>;
	className: string;
}) {
	return (
		<div
			ref={mirror}
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 z-10",
				className,
			)}
		>
			{tiles.map((tile) => (
				<div
					key={tile.id}
					data-placement-tile={tile.id}
					data-drop-placeholder={tile.id === active ? tile.id : undefined}
					className={cn(
						"min-w-0 rounded-lg",
						TILE_WIDTH_CLASS[tile.width],
						TILE_HEIGHT_CLASS[tile.height],
						tile.column !== null && TILE_COLUMN_CLASS[tile.column],
						tile.id === active
							? "border-2 border-dashed border-primary/60 bg-primary/10"
							: "invisible",
					)}
				/>
			))}
		</div>
	);
}
