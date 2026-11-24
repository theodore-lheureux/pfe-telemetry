import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LayoutGridIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useDisplayTimeZone } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import { IconEmptyState } from "../../components/workspace";
import { cn } from "../../lib/utils";
import { heatColor } from "../chart-heatmap";
import {
	axisTime,
	bucketTitle,
	type ChartPoint,
	ChartTooltipCard,
	TooltipRows,
} from "../charts";
import type { SeriesResult } from "../contracts";
import type { Display } from "./draft";
import type { SeriesView } from "./series-view";

const ROW_HEIGHT = 28;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * One row per series, such as each node, with its value in every bucket as a colored
 * cell. Rows are virtualized, so a breakdown can keep a whole cluster.
 */
export function SeriesGrid({
	view,
	step,
	display,
	pointsOf,
	gapLabel,
	height,
	onGroup,
}: {
	view: SeriesView;
	/** Bucket length in ms. */
	step: number;
	display: Pick<Display, "beginAtZero" | "yMax">;
	/** A series' points on the bucket grid. */
	pointsOf: (series: SeriesResult) => ChartPoint[];
	gapLabel: (series: SeriesResult, bucketMs: number) => string | null;
	height: string;
	/** Opens one row's group on its own. */
	onGroup?: (series: SeriesResult) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const rows = view.current;
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8,
	});
	const [hover, setHover] = useState<{
		row: number;
		bucket: number;
		x: number;
		y: number;
	} | null>(null);
	const locale = getLocale();
	const timeZone = useDisplayTimeZone();
	const points = rows.map(pointsOf);
	const buckets = points[0]?.map((point) => point.bucketMs) ?? [];
	const values = points.flatMap((row) =>
		row.flatMap((point) => (point.value === null ? [] : [point.value])),
	);
	const low = display.beginAtZero ? 0 : Math.min(...values);
	const high = display.yMax ?? Math.max(...values);
	const ratio = (value: number) => (value - low) / (high - low);
	const format = view.format(rows[0]);
	const time = axisTime(
		locale,
		timeZone,
		(buckets.at(-1) ?? 0) - (buckets[0] ?? 0),
	);
	const ticks = [
		...new Set(
			TICKS.map((at) => buckets[Math.round(at * (buckets.length - 1))]),
		),
	];
	const hovered = hover && points[hover.row]?.[hover.bucket];
	// Equal cells carry no color contrast, such as a p95 of mostly idle processes.
	if (!(high > low))
		return (
			<IconEmptyState
				icon={<LayoutGridIcon aria-hidden="true" />}
				title={m.insight_grid_uniform({ value: format(high) })}
				description={m.insight_grid_uniform_description()}
				className={height}
			/>
		);
	return (
		<div className={cn("flex min-h-0 flex-col gap-2", height)}>
			<div
				ref={scroller}
				className="min-h-0 flex-1 overflow-auto rounded-md border"
			>
				<div
					className="relative min-w-96"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map((item) => {
						const series = rows[item.index];
						return (
							<div
								key={item.key}
								className="absolute inset-x-0 flex items-center gap-2 border-b px-2"
								style={{ top: item.start, height: ROW_HEIGHT }}
							>
								<Button
									variant="ghost"
									size="xs"
									className="w-40 shrink-0 justify-start truncate"
									disabled={!onGroup || series.other}
									onClick={() => onGroup?.(series)}
								>
									{view.label(series)}
								</Button>
								<div
									className="grid h-4 min-w-0 flex-1 gap-px"
									style={{
										gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`,
									}}
									onPointerMove={(event) => {
										const box = event.currentTarget.getBoundingClientRect();
										setHover({
											row: item.index,
											bucket: Math.min(
												buckets.length - 1,
												Math.floor(
													((event.clientX - box.left) / box.width) *
														buckets.length,
												),
											),
											x: event.clientX,
											y: event.clientY,
										});
									}}
									onPointerLeave={() => setHover(null)}
								>
									{points[item.index].map(({ bucketMs, value }) => (
										<span
											key={bucketMs}
											className="rounded-[1px]"
											style={{
												background:
													value === null ? undefined : heatColor(ratio(value)),
											}}
										/>
									))}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			<div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
				<span className="flex w-40 shrink-0 items-center gap-2">
					<span className="tabular-nums">{format(low)}</span>
					<span
						aria-hidden="true"
						className="h-2 w-12 rounded-sm bg-[linear-gradient(to_right,var(--muted),var(--viz-1))]"
					/>
					<span className="tabular-nums">{format(high)}</span>
				</span>
				<span className="flex min-w-0 flex-1 justify-between">
					{ticks.map((bucket) => (
						<span key={bucket}>{time.format(bucket)}</span>
					))}
				</span>
			</div>
			{hover && hovered && (
				<div
					className="pointer-events-none fixed z-50"
					style={{ left: hover.x + 12, top: hover.y + 12 }}
				>
					<ChartTooltipCard
						title={bucketTitle(hovered.bucketMs, step, locale, timeZone)}
					>
						<TooltipRows
							items={[
								{
									key: "value",
									label: view.label(rows[hover.row]),
									color:
										hovered.value === null
											? undefined
											: heatColor(ratio(hovered.value)),
									block: true,
									value: hovered.value === null ? null : format(hovered.value),
									missing: gapLabel(rows[hover.row], hovered.bucketMs),
								},
							]}
						/>
					</ChartTooltipCard>
				</div>
			)}
		</div>
	);
}
