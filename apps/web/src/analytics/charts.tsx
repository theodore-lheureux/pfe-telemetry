import { m } from "@recount/i18n/messages";
import { type ComponentProps, useId, useMemo } from "react";
import { Area, Bar, ComposedChart, LabelList, Line, YAxis } from "recharts";
import { type ChartConfig, ChartContainer } from "../components/ui/chart";
import { cn } from "../lib/utils";
import { type TimelineContext, TimePlot } from "./chart-frame";
import { AreaMark } from "./chart-marks/area";
import { BarMark } from "./chart-marks/bar";
import { LineMark } from "./chart-marks/line";
import type { MarkProps } from "./chart-marks/types";
import { movingAveragePoints, trendPoints } from "./chart-overlays";
import { TooltipSwatch } from "./chart-swatch";

export interface ChartPoint {
	bucketMs: number;
	value: number | null;
	/** The band around the value across the sources it combines. */
	low?: number | null;
	high?: number | null;
}

export interface ChartSeries {
	format?: (value: number) => string;
	key: string;
	label: string;
	/** A CSS color, normally one of the fixed `--viz-N` categorical slots. */
	color: string;
	points: ChartPoint[];
	/** A comparison line, such as the previous period: lighter and dashed. */
	comparison?: boolean;
	/** Every value equals an earlier series', so it is dashed to keep both visible. */
	coincident?: boolean;
	/** A trend or moving average drawn over another series: thin, dotted, unlisted. */
	overlay?: boolean;
}

const TAIL = "~tail";
const BAND = "~band";

/**
 * Splits each current series into a solid part and a dashed tail for a bucket that is
 * still filling, so a partial value does not read as a real drop.
 */
function chartRows(
	series: ChartSeries[],
	bucketMs: number,
	now: number,
	logScale: boolean,
) {
	type Row = { bucketMs: number } & Record<
		string,
		number | [number, number] | null
	>;
	const rows = new Map<number, Row>();
	// A log axis cannot place zero or negative values, and one such value blanks the
	// whole chart, so they become gaps.
	const plottable = (value: number | null | undefined) =>
		value === undefined || value === null || (logScale && value <= 0)
			? null
			: value;
	for (const entry of series) {
		const points = entry.points.filter((point) => point.value !== null);
		const last = points.at(-1);
		const partial =
			!entry.comparison &&
			!entry.overlay &&
			last !== undefined &&
			last.bucketMs + bucketMs > now;
		for (const point of entry.points) {
			const row: Row = rows.get(point.bucketMs) ?? {
				bucketMs: point.bucketMs,
			};
			row[entry.key] =
				partial && point === last ? null : plottable(point.value);
			// A range area reads its lower and upper bound from one pair.
			if (
				point.low !== undefined &&
				point.low !== null &&
				point.high !== null &&
				point.high !== undefined
			)
				row[`${entry.key}${BAND}`] = [point.low, point.high];
			rows.set(point.bucketMs, row);
		}
		if (partial && last) {
			const previous = points.at(-2);
			for (const point of [previous, last])
				if (point) {
					const row = rows.get(point.bucketMs);
					if (row) row[`${entry.key}${TAIL}`] = plottable(point.value);
				}
		}
	}
	return [...rows.values()].sort((a, b) => a.bucketMs - b.bucketMs);
}

export interface TooltipItem {
	key: string;
	label: string;
	/** A swatch in the item's color: a line, or a block for a filled cell. */
	color?: string;
	block?: boolean;
	faded?: boolean;
	/** Null when the item has no value, explained by `missing`. */
	value: string | null;
	/** Secondary text after the value, such as a range or a share. */
	detail?: string;
	missing?: string | null;
}

/** Labeled values, one per line: the label muted, the value emphasized. */
export function TooltipRows({ items }: { items: TooltipItem[] }) {
	return items.map((item) => (
		<div key={item.key} className="flex items-center justify-between gap-4">
			<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
				{item.color && (
					<TooltipSwatch
						color={item.color}
						block={item.block}
						faded={item.faded}
					/>
				)}
				<span className="truncate">{item.label}</span>
			</span>
			{item.value === null ? (
				<span className="shrink-0 text-muted-foreground italic">
					{item.missing ?? "—"}
				</span>
			) : (
				<span className="shrink-0 font-medium">
					{item.value}
					{item.detail && (
						<span className="ml-1.5 font-normal text-muted-foreground">
							{item.detail}
						</span>
					)}
				</span>
			)}
		</div>
	));
}

function valueAxis({
	logScale,
	beginAtZero,
	yMax,
	overflows,
	flat,
	format,
}: {
	logScale: boolean;
	beginAtZero: boolean;
	yMax?: number;
	overflows: boolean;
	/** Every value is zero, where automatic ticks would stretch to an arbitrary 0–4. */
	flat: boolean;
	format: (value: number) => string;
}): ComponentProps<typeof YAxis> {
	let top: number | "auto" = flat ? 1 : "auto";
	if (yMax !== undefined && Number.isFinite(yMax)) top = yMax;
	return {
		// A log axis cannot start at zero; non-positive values fall outside it.
		scale: logScale ? ("log" as const) : ("auto" as const),
		domain: [logScale || !beginAtZero ? "auto" : 0, top],
		allowDataOverflow: logScale || overflows,
		tickFormatter: (value: number) => format(value),
	};
}

function seriesItem(
	entry: ChartSeries,
	row: Record<string, unknown>,
	format: (value: number) => string,
	missing?: string | null,
): TooltipItem {
	const valueText = entry.format ?? format;
	const value = row[entry.key] ?? row[`${entry.key}${TAIL}`];
	const band = row[`${entry.key}${BAND}`] as [number, number] | undefined;
	return {
		key: entry.key,
		label: entry.label,
		color: entry.color,
		faded: entry.comparison,
		value: typeof value === "number" ? valueText(value) : null,
		detail: band && `${valueText(band[0])}–${valueText(band[1])}`,
		missing,
	};
}

export type ChartType = "auto" | "line" | "area" | "bar" | "stacked";
const MAX_VALUE_LABELS = 16;

export function TimeseriesChart({
	series,
	bucketSeconds,
	format,
	axisFormat = format,
	label,
	className,
	type = "auto",
	logScale = false,
	beginAtZero = true,
	goal,
	domain,
	bands,
	gapLabel,
	onZoom,
	legend = true,
	legendPosition = "bottom",
	showValues = false,
	xLabel,
	yLabel,
	yMax,
	smooth = false,
	trend = false,
	movingAverage,
	highlight = null,
	height = "h-72",
}: TimelineContext & {
	series: ChartSeries[];
	bucketSeconds: number;
	format: (value: number) => string;
	/** Axis ticks, when they leave out what the axis title names; defaults to `format`. */
	axisFormat?: (value: number) => string;
	label: string;
	className?: string;
	/** `auto` fills a single series and draws several as lines. */
	type?: ChartType;
	logScale?: boolean;
	beginAtZero?: boolean;
	/** A dashed horizontal reference line. */
	goal?: number;
	/** Why a series has no value in a bucket, shown in the tooltip. */
	gapLabel?: (key: string, bucketMs: number) => string | null;
	/** Lists the series beside the chart; off when a table already names them. */
	legend?: boolean;
	legendPosition?: "bottom" | "right";
	/** Labels each point with its value. */
	showValues?: boolean;
	xLabel?: string;
	yLabel?: string;
	/** The Y axis' upper bound; automatic when absent. */
	yMax?: number;
	/** Curves between points instead of straight segments. */
	smooth?: boolean;
	/** Draws a least-squares line over each series. */
	trend?: boolean;
	/** Draws the mean of this many trailing buckets over each series. */
	movingAverage?: number;
	/** A series key to emphasize; the others fade. */
	highlight?: string | null;
	/** The plot's height class; `h-full` fills a sized parent. */
	height?: string;
}) {
	const gradient = useId().replace(/:/g, "");
	// Opacity for a series: faded while another one is highlighted.
	const emphasis = (key: string) =>
		highlight === null || highlight === key ? 1 : 0.15;
	const now = Date.now();
	const current = series.filter((entry) => !entry.comparison);
	// Overlays leave out a bucket still filling, whose partial value would skew them.
	const overlays = useMemo(() => {
		const settled = (points: ChartPoint[]) => {
			const last = points.at(-1);
			return last && last.bucketMs + bucketSeconds * 1000 > now
				? points.slice(0, -1)
				: points;
		};
		return series
			.filter((entry) => !entry.comparison)
			.flatMap((entry): ChartSeries[] => [
				...(trend
					? [
							{
								key: `${entry.key}~trend`,
								label: m.chart_trend({ series: entry.label }),
								color: entry.color,
								points: trendPoints(settled(entry.points)),
								overlay: true,
							},
						]
					: []),
				...(movingAverage && movingAverage > 1
					? [
							{
								key: `${entry.key}~average`,
								label: m.chart_moving_average({
									series: entry.label,
									count: movingAverage,
								}),
								color: entry.color,
								points: movingAveragePoints(
									settled(entry.points),
									movingAverage,
								),
								overlay: true,
							},
						]
					: []),
			]);
	}, [series, trend, movingAverage, bucketSeconds, now]);
	const drawn = useMemo(() => [...series, ...overlays], [series, overlays]);
	const rows = useMemo(
		() => chartRows(drawn, bucketSeconds * 1000, now, logScale),
		[drawn, bucketSeconds, now, logScale],
	);
	const capped = yMax !== undefined && Number.isFinite(yMax);
	// Clipping to a fixed maximum would also halve a line drawn exactly at it, so the
	// plot clips only when something rises above it.
	const overflows = useMemo(
		() =>
			capped &&
			(type === "stacked" ||
				drawn.some((entry) =>
					entry.points.some(
						(point) => Math.max(point.value ?? 0, point.high ?? 0) > yMax,
					),
				)),
		[capped, type, drawn, yMax],
	);
	const curve = smooth ? "monotone" : "linear";
	// A single current series gets a soft area; several stay lines so fills never overlap.
	const filled = type === "area" || (type === "auto" && current.length === 1);
	const bars = type === "bar" || type === "stacked";
	const config = Object.fromEntries(
		drawn.map((entry) => [
			entry.key,
			{ label: entry.label, color: entry.color },
		]),
	) satisfies ChartConfig;
	// Labels every few buckets on long ranges, so neighbouring labels never overlap.
	const labelEvery = Math.max(1, Math.ceil(rows.length / MAX_VALUE_LABELS));
	// One mark per series: comparisons are dashed lines, the rest follow the chart type.
	const values = (entry: ChartSeries) =>
		showValues && (
			<LabelList
				valueAccessor={(label, index) => {
					const value = (label.payload as Record<string, unknown>)[entry.key];
					return index % labelEvery === 0 && typeof value === "number"
						? (entry.format ?? format)(value)
						: "";
				}}
				position="top"
				fontSize={10}
				fill="var(--muted-foreground)"
			/>
		);
	const mark = (entry: ChartSeries) => {
		if (entry.overlay)
			return (
				<Line
					key={entry.key}
					dataKey={entry.key}
					type={curve}
					stroke={entry.color}
					strokeOpacity={0.8 * emphasis(entry.key.split("~")[0] ?? "")}
					strokeWidth={1.5}
					strokeDasharray="2 3"
					dot={false}
					activeDot={false}
					legendType="none"
					isAnimationActive={false}
				/>
			);
		if (entry.comparison)
			return (
				<Line
					key={entry.key}
					dataKey={entry.key}
					type={curve}
					stroke={entry.color}
					strokeOpacity={0.45 * emphasis(entry.key)}
					strokeWidth={2}
					strokeDasharray="4 4"
					dot={false}
					isAnimationActive={false}
				/>
			);
		const props: MarkProps = {
			entry,
			curve,
			opacity: emphasis(entry.key),
			values: values(entry),
		};
		if (bars)
			return (
				<BarMark key={entry.key} {...props} stacked={type === "stacked"} />
			);
		if (filled)
			return (
				<AreaMark
					key={entry.key}
					{...props}
					gradient={current.length === 1 ? gradient : undefined}
				/>
			);
		return <LineMark key={entry.key} {...props} />;
	};
	return (
		<TimePlot
			rows={rows}
			config={config}
			label={label}
			className={className}
			height={height}
			step={bucketSeconds * 1000}
			bands={bands}
			domain={domain}
			onZoom={onZoom}
			xLabel={xLabel}
			yLabel={yLabel}
			axis={valueAxis({
				logScale,
				beginAtZero,
				yMax,
				overflows,
				format: axisFormat,
				flat: drawn.every((entry) =>
					entry.points.every((point) => !point.value),
				),
			})}
			goal={goal}
			showValues={showValues}
			legendOnRight={legend && legendPosition === "right"}
			legend={
				legend &&
				series.length > 1 && (
					<SeriesLegend series={series} position={legendPosition} />
				)
			}
			definitions={
				<linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={current[0]?.color} stopOpacity={0.22} />
					<stop offset="100%" stopColor={current[0]?.color} stopOpacity={0} />
				</linearGradient>
			}
			tooltip={(bucketMs, row) => (
				<TooltipRows
					items={drawn.map((entry) =>
						seriesItem(entry, row, format, gapLabel?.(entry.key, bucketMs)),
					)}
				/>
			)}
		>
			{current
				.filter((entry) =>
					entry.points.some((point) => point.low !== undefined),
				)
				.map((entry) => (
					<Area
						key={`${entry.key}${BAND}`}
						dataKey={`${entry.key}${BAND}`}
						type={curve}
						stroke="none"
						fill={entry.color}
						fillOpacity={0.15 * emphasis(entry.key)}
						dot={false}
						activeDot={false}
						legendType="none"
						isAnimationActive={false}
					/>
				))}
			{drawn.map(mark)}
			{(bars ? [] : current).map((entry) => (
				<Line
					key={`${entry.key}${TAIL}`}
					dataKey={`${entry.key}${TAIL}`}
					type={curve}
					stroke={entry.color}
					strokeOpacity={emphasis(entry.key)}
					strokeWidth={2}
					strokeDasharray="4 4"
					dot={false}
					activeDot={false}
					legendType="none"
					isAnimationActive={false}
				/>
			))}
		</TimePlot>
	);
}

function SeriesLegend({
	series,
	position,
}: {
	series: ChartSeries[];
	position: "bottom" | "right";
}) {
	return (
		<ul
			className={cn(
				"flex gap-x-4 gap-y-1 text-xs text-muted-foreground",
				position === "right"
					? "w-40 shrink-0 flex-col justify-center overflow-y-auto"
					: "flex-wrap justify-center",
			)}
		>
			{series.map((entry) => (
				<li key={entry.key} className="flex items-center gap-1.5">
					<svg aria-hidden="true" width="14" height="4" className="shrink-0">
						<line
							x1="0"
							y1="2"
							x2="14"
							y2="2"
							stroke={entry.color}
							strokeWidth="2"
							strokeOpacity={entry.comparison ? 0.45 : 1}
							strokeDasharray={entry.comparison ? "4 3" : undefined}
						/>
					</svg>
					{entry.label}
				</li>
			))}
		</ul>
	);
}

/** A small, axis-free trend for stat tiles. */
export function Sparkline({
	points,
	bucketSeconds,
	color = "var(--viz-1)",
	type = "area",
	smooth = false,
	beginAtZero = false,
}: {
	points: ChartPoint[];
	bucketSeconds: number;
	color?: string;
	type?: "line" | "area" | "bar";
	smooth?: boolean;
	beginAtZero?: boolean;
}) {
	const gradient = useId().replace(/:/g, "");
	const now = Date.now();
	const rows = useMemo(
		() =>
			chartRows(
				[{ key: "value", label: "", color, points }],
				bucketSeconds * 1000,
				now,
				false,
			),
		[points, bucketSeconds, color, now],
	);
	return (
		<ChartContainer
			config={{ value: { color } }}
			className="aspect-auto h-full w-full"
			aria-hidden="true"
		>
			<ComposedChart
				data={rows}
				margin={{ left: 0, right: 0, top: 4, bottom: 0 }}
			>
				<defs>
					<linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={color} stopOpacity={0.2} />
						<stop offset="100%" stopColor={color} stopOpacity={0} />
					</linearGradient>
				</defs>
				<YAxis hide domain={[beginAtZero ? 0 : "dataMin", "dataMax"]} />
				{type === "bar" ? (
					<>
						<Bar dataKey="value" fill={color} isAnimationActive={false} />
						<Bar
							dataKey={`value${TAIL}`}
							fill={color}
							fillOpacity={0.4}
							isAnimationActive={false}
						/>
					</>
				) : (
					<>
						<Area
							dataKey="value"
							type={smooth ? "monotone" : "linear"}
							stroke={color}
							strokeWidth={1.5}
							fill={type === "area" ? `url(#${gradient})` : "none"}
							dot={false}
							isAnimationActive={false}
						/>
						<Line
							dataKey={`value${TAIL}`}
							type={smooth ? "monotone" : "linear"}
							stroke={color}
							strokeWidth={1.5}
							strokeDasharray="3 3"
							dot={false}
							isAnimationActive={false}
						/>
					</>
				)}
			</ComposedChart>
		</ChartContainer>
	);
}
