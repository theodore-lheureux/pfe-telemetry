import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { useState } from "react";
import { Line, usePlotArea, useXAxisScale, useYAxisScale } from "recharts";
import { IconEmptyState } from "../../../components/workspace";
import { cn } from "../../../lib/utils";
import { TimePlot } from "../../chart-frame";
import { ColorScale, heatColor, TooltipSwatch } from "../../chart-swatch";
import type { QueryResult, SeriesResult } from "../../contracts";
import { coverageOmissionLabel } from "../../coverage-labels";
import { metricLabel } from "../../definition-labels";
import { histogramLabels } from "../../histogram-labels";
import { bucketRange } from "../../histograms";
import {
	approximateCount,
	countText,
	formatMetricValue,
	metricValuesFormatter,
	ratioScale,
} from "../../metric-units";
import type { Display } from "../draft";
import { calculationLabel, formatValue, seriesSource } from "../labels";
import { lineId } from "../series-view";
import type { PanelProps } from "./types";

interface Buckets {
	bounds: number[];
	columns: { bucketMs: number; counts: number[] }[];
	scale?: number;
}

export function heatmapLayout<T extends Buckets>(
	heatmap: T,
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
type Heatmap = NonNullable<ReturnType<typeof heatmapData>>;
type Layout = ReturnType<typeof heatmapLayout<Heatmap>>;

function heatmapAxis(rows: Layout) {
	return {
		scale: "auto" as const,
		domain: [rows.first, rows.last + 1],
		ticks: [...rows.indices, rows.last + 1].filter(
			(index) => rows.bounds[index - 1] !== undefined,
		),
		tickFormatter: (index: number) => rows.format(rows.bounds[index - 1] ?? 0),
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

function heatmapTooltip(
	heatmap: Layout,
	bucketMs: number,
	index: number,
	step: number,
) {
	const locale = getLocale();
	const counts =
		heatmap.columns.find((column) => column.bucketMs === bucketMs)?.counts ??
		[];
	const count = counts[index] ?? 0;
	const range = heatmap.range({
		range: bucketRange(heatmap.bounds, index, heatmap.format),
	});
	if (!count)
		return (
			<p className="text-muted-foreground">
				{heatmap.count(0)} {range}
			</p>
		);
	const total = counts.reduce((sum, value) => sum + value, 0);
	const omitted = heatmap.omitted?.get(bucketMs) ?? 0;
	return (
		<>
			<p className="flex items-center gap-1.5">
				<TooltipSwatch color={cellColor(count, heatmap.peak)} block />
				<span className="font-medium">{heatmap.count(count)}</span>
			</p>
			<p>{range}</p>
			<p className="text-muted-foreground">
				{(SHARE[step] ?? m.histogram_share_interval)({
					share: formatMetricValue(count / total, "1", locale).text,
					total: heatmap.count(total),
				})}
				{omitted > 0
					? ` ${coverageOmissionLabel(heatmap.omissionReason, approximateCount(omitted, locale))}`
					: ""}
			</p>
		</>
	);
}

function HeatmapCells({
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

function heatmapData(
	result: QueryResult,
	series: SeriesResult,
	display: Display,
) {
	const measure = seriesSource(result, series);
	if (!measure || !series.bounds) return null;
	const { unit, presentation } = measure;
	const label = metricLabel(measure.metric, measure.label);
	const locale = getLocale();
	const auto = metricValuesFormatter(unit, series.bounds, locale);
	const group = JSON.stringify(series.group);
	const omissions = result.omissions?.find(
		(other) =>
			other.measure === series.measure && JSON.stringify(other.group) === group,
	);
	return {
		label,
		bounds: series.bounds,
		columns: series.points.flatMap(({ bucketMs, counts }) =>
			bucketMs === null || !counts ? [] : [{ bucketMs, counts }],
		),
		...histogramLabels(presentation?.quantity, label),
		subject: calculationLabel("count", unit),
		count: (value: number) =>
			countText(
				unit,
				approximateCount(value, locale),
				Math.round(value),
				locale,
			),
		scale: ratioScale(unit),
		omissionReason: presentation?.coverage?.reason,
		omitted:
			omissions &&
			new Map(omissions.points.map(({ bucketMs, value }) => [bucketMs, value])),
		format: (value: number) =>
			display.unit === "auto"
				? auto(value).text
				: formatValue(value, display, null, locale),
	};
}

// Recharts requires a drawn series before it dispatches a tooltip for a column.
const CELLS = "~cells";
function HeatmapPlot({
	heatmap,
	display,
	height,
	bucketSeconds,
	timeline,
}: Pick<PanelProps, "display" | "height" | "bucketSeconds" | "timeline"> & {
	heatmap: Heatmap;
}) {
	const [row, setRow] = useState<number | null>(null);
	const layout = heatmapLayout(
		heatmap,
		display.beginAtZero,
		display.yMax,
		display.yMin,
	);
	const step = bucketSeconds * 1000;
	return (
		<TimePlot
			{...timeline}
			rows={layout.columns.map(({ bucketMs }) => ({ bucketMs, [CELLS]: 0 }))}
			config={{}}
			label={m.insight_chart_label()}
			height={height}
			className={height}
			step={step}
			xLabel={display.xLabel}
			yLabel={display.yLabel ?? heatmap.quantity}
			goal={display.goal}
			showValues={display.showValues}
			axis={heatmapAxis(layout)}
			legendOnRight={display.legend === "right"}
			legend={
				<p className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
					<span>{layout.subject}</span>
					<ColorScale
						from="0"
						to={approximateCount(layout.peak, getLocale())}
						width="w-24"
					/>
				</p>
			}
			tooltip={(bucketMs) =>
				row === null ? null : heatmapTooltip(layout, bucketMs, row, step)
			}
		>
			<Line
				dataKey={CELLS}
				stroke="none"
				dot={false}
				activeDot={false}
				legendType="none"
				isAnimationActive={false}
			/>
			<HeatmapCells rows={layout} step={step} onRow={setRow} />
		</TimePlot>
	);
}

export function heatmapTitle(result: QueryResult) {
	const displayed = new Set(
		result.series
			.filter((series) => series.bounds)
			.map(({ measure }) => measure),
	);
	return [
		...new Set(
			result.measures
				.filter(({ name }) => displayed.has(name))
				.map(({ metric, label }) => metricLabel(metric, label)),
		),
	].join(", ");
}

function heatmapEmptyDetail(result: QueryResult, fallback?: string) {
	const omitted = result.omissions?.find((series) =>
		series.points.some(({ value }) => (value ?? 0) > 0),
	);
	if (!omitted) return fallback;
	const reason = seriesSource(result, omitted)?.presentation?.coverage?.reason;
	return reason === "idle"
		? m.insight_all_idle()
		: m.metric_coverage_all_omitted();
}

export function HeatmapPanel({
	result,
	view,
	fill,
	emptyDetail,
	...plot
}: PanelProps) {
	const series = view.current.filter((item) => item.bounds);
	const hasCounts = series.some((item) =>
		item.points.some(({ counts }) => counts?.some((count) => count > 0)),
	);
	if (!hasCounts)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.insight_empty_result()}
				description={heatmapEmptyDetail(result, emptyDetail)}
				className={plot.height}
			/>
		);
	const multiple = new Set(series.map((item) => item.measure)).size > 1;
	return (
		<div
			className={cn("flex flex-col gap-4", fill && "h-full overflow-y-auto")}
		>
			{series.map((item) => {
				const heatmap = heatmapData(result, item, plot.display);
				if (!heatmap) return null;
				const title = [multiple && heatmap.label, view.groupLabel(item)]
					.filter(Boolean)
					.join(" · ");
				return (
					<section
						key={lineId(item)}
						className={cn("flex flex-col gap-1", fill && "min-h-56 flex-1")}
					>
						{title && <h3 className="text-sm font-medium">{title}</h3>}
						<HeatmapPlot {...plot} heatmap={heatmap} />
					</section>
				);
			})}
		</div>
	);
}
