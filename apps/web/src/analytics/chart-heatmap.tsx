import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { usePlotArea, useXAxisScale, useYAxisScale } from "recharts";
import { TooltipSwatch } from "./chart-swatch";
import { bucketRange } from "./histograms";
import { approximateCount, formatMetricValue } from "./metric-units";

export interface Heatmap {
	bounds: number[];
	columns: { bucketMs: number; counts: number[] }[];
	subject: string;
	count: (count: number, locale: string) => string;
	range: (inputs: { range: string }) => string;
	idle?: Map<number | null, number | null>;
	scale?: number;
}

/** A cell color between the muted background (0) and the first series color (1). */
export function heatColor(ratio: number) {
	return `color-mix(in oklab, var(--viz-1) ${100 * Math.min(1, Math.max(0, ratio))}%, var(--muted))`;
}

export function heatmapLayout(
	heatmap: Heatmap,
	beginAtZero: boolean,
	yMax?: number,
	yMin?: number,
) {
	const { bounds, columns } = heatmap;
	const occupied = bounds
		.concat(0)
		.flatMap((_, index) =>
			columns.some((column) => column.counts[index] > 0) ? [index] : [],
		);
	const holding = (value: number) => {
		const index = bounds.findIndex((bound) => bound >= value);
		return index < 0 ? bounds.length : index;
	};
	const lowest = yMin ?? (beginAtZero ? 0 : undefined);
	const start = lowest === undefined ? (occupied[0] ?? 0) : holding(lowest);
	let last = occupied.at(-1) ?? start;
	if (heatmap.scale !== undefined)
		last = Math.max(last, holding(heatmap.scale));
	if (yMax !== undefined && Number.isFinite(yMax)) last = holding(yMax);
	const first = Math.min(start, last);
	const indices = Array.from({ length: last - first + 1 }, (_, i) => first + i);
	const peak = columns.reduce(
		(max, column) =>
			indices.reduce(
				(best, index) => Math.max(best, column.counts[index] ?? 0),
				max,
			),
		1,
	);
	return { ...heatmap, first, last, peak, indices };
}
type Layout = ReturnType<typeof heatmapLayout>;

export function heatmapAxis(rows: Layout, format: (value: number) => string) {
	return {
		scale: "auto" as const,
		domain: [rows.first, rows.last + 1],
		ticks: [...rows.indices, rows.last + 1].filter(
			(index) => rows.bounds[index - 1] !== undefined,
		),
		tickFormatter: (index: number) => format(rows.bounds[index - 1] ?? 0),
		allowDataOverflow: true,
	};
}

const SHARE: Record<number, typeof m.histogram_share_minute> = {
	60000: m.histogram_share_minute,
	3600000: m.histogram_share_hour,
	86400000: m.histogram_share_day,
};
const cellColor = (count: number, peak: number) =>
	heatColor(Math.log1p(count) / Math.log1p(peak));

export function HeatmapTooltip({
	heatmap,
	bucketMs,
	index,
	step,
	format,
}: {
	heatmap: Layout;
	bucketMs: number;
	index: number;
	step: number;
	format: (value: number) => string;
}) {
	const locale = getLocale();
	const counts =
		heatmap.columns.find((column) => column.bucketMs === bucketMs)?.counts ??
		[];
	const count = counts[index] ?? 0;
	const range = heatmap.range({
		range: bucketRange(heatmap.bounds, index, format),
	});
	if (!count)
		return (
			<p className="text-muted-foreground">
				{heatmap.count(0, locale)} {range}
			</p>
		);
	const total = counts.reduce((sum, value) => sum + value, 0);
	const idle = heatmap.idle?.get(bucketMs);
	return (
		<>
			<p className="flex items-center gap-1.5">
				<TooltipSwatch color={cellColor(count, heatmap.peak)} block />
				<span className="font-medium">{heatmap.count(count, locale)}</span>
			</p>
			<p>{range}</p>
			<p className="text-muted-foreground">
				{(SHARE[step] ?? m.histogram_share_interval)({
					share: formatMetricValue(count / total, "1", locale).text,
					total: heatmap.count(total, locale),
				})}
				{idle
					? ` ${m.histogram_idle({ count: approximateCount(idle, locale) })}`
					: ""}
			</p>
		</>
	);
}

export function HeatmapLegend({
	subject,
	peak,
}: Pick<Layout, "subject" | "peak">) {
	return (
		<p className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
			<span>{subject}</span>
			<span className="tabular-nums">0</span>
			<span
				aria-hidden="true"
				className="h-2 w-24 rounded-sm bg-[linear-gradient(to_right,var(--muted),var(--viz-1))]"
			/>
			<span className="tabular-nums">
				{approximateCount(peak, getLocale())}
			</span>
		</p>
	);
}

export function HeatmapCells({
	rows,
	step,
	onRow,
}: {
	rows: Layout;
	step: number;
	onRow: (index: number | null) => void;
}) {
	const x = useXAxisScale();
	const y = useYAxisScale();
	const area = usePlotArea();
	if (!x || !y || !area) return null;
	const top = (index: number) => y(index + 1) ?? 0;
	const height = (index: number, gap = 0) =>
		Math.max(0, (y(index) ?? top(index)) - top(index) - gap);
	return (
		<g onPointerLeave={() => onRow(null)}>
			{rows.columns.map(({ bucketMs, counts }) => {
				const left = x(bucketMs) ?? 0;
				const width = Math.max(0, (x(bucketMs + step) ?? left) - left - 1);
				return rows.indices.map(
					(index) =>
						counts[index] > 0 && (
							<rect
								key={`${bucketMs}:${index}`}
								x={left}
								y={top(index)}
								width={width}
								height={height(index, 1)}
								fill={cellColor(counts[index], rows.peak)}
							/>
						),
				);
			})}
			{rows.indices.map((index) => (
				<rect
					key={index}
					x={area.x}
					y={top(index)}
					width={area.width}
					height={height(index)}
					fill="transparent"
					onPointerEnter={() => onRow(index)}
				/>
			))}
		</g>
	);
}
