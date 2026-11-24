import {
	cloneElement,
	type KeyboardEvent,
	type ReactElement,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	GridLayout,
	type Layout,
	type LayoutItem,
	type ResizeHandleAxis,
	useContainerWidth,
} from "react-grid-layout";
import { bottom, calcGridItemPosition } from "react-grid-layout/core";
import { GridBackground } from "react-grid-layout/extras";
import "react-grid-layout/css/styles.css";
import { m } from "@recount/i18n/messages";
import { cn } from "../../lib/utils";
import { GRID_COLUMNS, TILE_HEIGHTS, TILE_WIDTHS } from "../dashboards";
import {
	dashboardCompactor,
	type GridResize,
} from "./dashboard-grid-compaction";

const GAP = 16;
const ROW_HEIGHT = 128;
const gridConfig = {
	cols: GRID_COLUMNS,
	rowHeight: ROW_HEIGHT,
	margin: [GAP, GAP] as const,
	containerPadding: [0, 0] as const,
};

const resizeEdges = {
	s: "inset-x-3! bottom-0! left-3! m-0! h-1.5! w-auto! cursor-ns-resize! transform-none!",
	w: "inset-y-3! left-0! m-0! h-auto! w-1.5! cursor-ew-resize! transform-none!",
	e: "inset-y-3! right-0! m-0! h-auto! w-1.5! cursor-ew-resize! transform-none!",
	sw: "bottom-0! left-0! size-3! cursor-nesw-resize! transform-none!",
	se: "right-0.5! bottom-0.5! flex size-5! cursor-nwse-resize! items-end justify-end rounded-sm p-1 text-muted-foreground hover:text-foreground",
} satisfies Partial<Record<ResizeHandleAxis, string>>;

function resizeHandle(
	axis: ResizeHandleAxis,
	ref: React.Ref<HTMLElement>,
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void,
) {
	if (!Object.hasOwn(resizeEdges, axis)) return null;
	const className = cn(
		`react-resizable-handle react-resizable-handle-${axis}`,
		"z-10 touch-none after:content-none!",
		resizeEdges[axis as keyof typeof resizeEdges],
	);
	if (axis !== "se")
		return <span ref={ref} aria-hidden="true" className={className} />;
	return (
		<button
			type="button"
			ref={ref as React.Ref<HTMLButtonElement>}
			aria-label={m.dashboard_resize_instructions()}
			onKeyDown={onKeyDown}
			className={cn(
				className,
				"focus-visible:opacity-100! focus-visible:ring-2 focus-visible:ring-ring",
			)}
		>
			<svg
				aria-hidden="true"
				viewBox="0 0 10 10"
				className="size-2.5"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.25"
			>
				<path d="M9 1 1 9M9 5 5 9" />
			</svg>
		</button>
	);
}

export function DashboardGridLayout({
	layout,
	disabled,
	children,
	onLayout,
}: {
	layout: Layout;
	disabled: boolean;
	children: ReactElement[];
	onLayout: (layout: Layout) => void;
}) {
	const { width, containerRef, mounted } = useContainerWidth({
		measureBeforeMount: true,
	});
	const [guideRows, setGuideRows] = useState(0);
	const [target, setTarget] = useState<LayoutItem | null>(null);
	const [moving, setMoving] = useState<{ id: string } | null>(null);
	const resize = useRef<GridResize | null>(null);
	const compactor = useMemo(() => dashboardCompactor(() => resize.current), []);
	const start = (layout: Layout, tile: LayoutItem | null) => {
		if (!tile) return;
		setGuideRows(bottom(layout) + 4);
		setTarget(tile);
	};
	const startResize = (layout: Layout, tile: LayoutItem | null) => {
		if (!tile) return;
		resize.current = {
			id: tile.i,
			baseline: layout.map((item) => ({ ...item })),
		};
		start(layout, tile);
	};
	const showTarget = useCallback(
		(
			layout: Layout,
			_original: LayoutItem | null,
			active: LayoutItem | null,
		) => {
			if (!active) return;
			setMoving({ id: active.i });
			// Highlight the cells under the carried tile, not where it will compact on drop.
			const { x, y, w, h } = active;
			setTarget((previous) =>
				previous?.x === x &&
				previous.y === y &&
				previous.w === w &&
				previous.h === h
					? previous
					: { i: active.i, x, y, w, h },
			);
			setGuideRows((rows) => Math.max(rows, bottom(layout) + 4));
		},
		[],
	);
	const stop = useCallback(
		(layout: Layout) => {
			resize.current = null;
			setGuideRows(0);
			setTarget(null);
			setMoving(null);
			onLayout(layout);
		},
		[onLayout],
	);
	const resizeByKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (disabled) return;
		const delta = resizeKeys[event.key];
		if (!delta) return;
		const id = event.currentTarget.closest<HTMLElement>("[data-dashboard-tile]")
			?.dataset.dashboardTile;
		const tile = layout.find((item) => item.i === id);
		if (!tile) return;
		event.preventDefault();
		const w = Math.min(
			GRID_COLUMNS - tile.x,
			Math.max(TILE_WIDTHS[0], tile.w + delta[0]),
		);
		const h = Math.min(TILE_HEIGHTS.length, Math.max(1, tile.h + delta[1]));
		if (w === tile.w && h === tile.h) return;
		resize.current = { id: tile.i, baseline: layout };
		const next = layout.map((item) =>
			item === tile ? { ...tile, w, h } : item,
		);
		stop(compactor.compact(next, GRID_COLUMNS));
	};
	// RGL stores the pixel position in a ref, but memoizes items by snapped
	// coordinates. Refresh only the moving item's wrapper, not its tile content.
	const gridChildren = useMemo(() => {
		if (!moving) return children;
		return children.map((child) =>
			child.key === moving.id ? cloneElement(child, { key: child.key }) : child,
		);
	}, [children, moving]);
	const preview =
		target &&
		calcGridItemPosition(
			{ ...gridConfig, containerWidth: width, maxRows: Infinity },
			target.x,
			target.y,
			target.w,
			target.h,
		);
	return (
		<div ref={containerRef}>
			{mounted && width >= 740 ? (
				<div className="relative">
					{guideRows > 0 && (
						<GridBackground
							{...gridConfig}
							width={width}
							rows={guideRows}
							borderRadius={6}
							className="dashboard-grid-guides pointer-events-none absolute inset-0 [&_rect]:fill-primary/[0.03] [&_rect]:stroke-primary/25 [&_rect]:[stroke-dasharray:4_4]"
						/>
					)}
					{preview && target && (
						<div
							aria-hidden="true"
							data-drop-placeholder
							className="pointer-events-none absolute z-[2]"
							style={preview}
						>
							<GridBackground
								{...gridConfig}
								width={preview.width}
								cols={target.w}
								rows={target.h}
								borderRadius={6}
								className="[&_rect]:fill-primary/10 [&_rect]:stroke-primary/60 [&_rect]:[stroke-dasharray:4_4]"
							/>
						</div>
					)}
					<GridLayout
						className={cn(
							"[&_.react-draggable>article>header]:cursor-grab [&_.react-draggable>article>header]:select-none",
							"[&_.react-draggable-dragging>article>header]:cursor-grabbing",
							"[&_.react-draggable-dragging>article]:shadow-lg [&_.react-draggable-dragging>article]:ring-2 [&_.react-draggable-dragging>article]:ring-primary",
							"[&_.resizing>article]:shadow-lg [&_.resizing>article]:ring-2 [&_.resizing>article]:ring-primary/60",
							"[&_.react-grid-placeholder]:hidden",
						)}
						width={width}
						layout={layout}
						compactor={compactor}
						onDragStart={start}
						onResizeStart={startResize}
						onDrag={showTarget}
						onResize={showTarget}
						onDragStop={stop}
						onResizeStop={stop}
						gridConfig={gridConfig}
						dragConfig={{
							enabled: !disabled,
							handle: "header",
							cancel: "a, button, input, select, textarea",
						}}
						resizeConfig={{
							enabled: !disabled,
							handles: ["s", "w", "e", "sw", "se"],
							handleComponent: (axis, ref) =>
								resizeHandle(axis, ref, resizeByKey),
						}}
					>
						{gridChildren}
					</GridLayout>
				</div>
			) : (
				<div className="grid auto-rows-[8rem] grid-cols-1 gap-4">
					{children}
				</div>
			)}
		</div>
	);
}

const resizeKeys: Record<string, readonly [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};
