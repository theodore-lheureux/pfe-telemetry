import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useId, useMemo, useState } from "react";
import {
	Area,
	Bar,
	CartesianGrid,
	ComposedChart,
	LabelList,
	Line,
	ReferenceArea,
	ReferenceLine,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useDisplayTimeZone } from "../components/time-display";
import { type ChartConfig, ChartContainer } from "../components/ui/chart";
import { cn } from "../lib/utils";
import { movingAveragePoints, trendPoints } from "./chart-overlays";

export interface ChartPoint {
	bucketMs: number;
	value: number | null;
	/** The band around the value across the sources it combines. */
	low?: number | null;
	high?: number | null;
}

export interface ChartSeries {
	key: string;
	label: string;
	/** A CSS color, normally one of the fixed `--viz-N` categorical slots. */
	color: string;
	points: ChartPoint[];
	/** A comparison line, such as the previous period: lighter and dashed. */
	comparison?: boolean;
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
	const rows = new Map<number, Record<string, number | null>>();
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
			const row: Record<string, unknown> = rows.get(point.bucketMs) ?? {
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
			rows.set(point.bucketMs, row as Record<string, number | null>);
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
	return [...rows.values()].sort(
		(a, b) => (a.bucketMs ?? 0) - (b.bucketMs ?? 0),
	);
}

function TooltipCard({
	active,
	payload,
	label,
	series,
	format,
	gapLabel,
	formatTime,
}: {
	active?: boolean;
	payload?: readonly { payload?: unknown }[];
	label?: unknown;
	series: ChartSeries[];
	format: (value: number) => string;
	gapLabel?: (key: string, bucketMs: number) => string | null;
	formatTime: (bucketMs: number) => string;
}) {
	if (!active || !payload?.length || typeof label !== "number") return null;
	const row = payload[0]?.payload as Record<string, number | null>;
	return (
		<div className="grid min-w-44 gap-1.5 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
			<p className="font-medium tabular-nums">{formatTime(label)}</p>
			{series.map((entry) => {
				const value = row[entry.key] ?? row[`${entry.key}${TAIL}`] ?? null;
				const band = (row as Record<string, unknown>)[`${entry.key}${BAND}`] as
					| [number, number]
					| undefined;
				return (
					<div
						key={entry.key}
						className="flex items-center justify-between gap-4"
					>
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<span
								aria-hidden="true"
								className={cn(
									"h-0.5 w-3 rounded-full",
									entry.comparison && "opacity-50",
								)}
								style={{ background: entry.color }}
							/>
							{entry.label}
						</span>
						{value === null ? (
							<span className="text-muted-foreground italic">
								{gapLabel?.(entry.key, label) ?? "—"}
							</span>
						) : (
							<span className="font-mono tabular-nums">
								{format(value)}
								{band && (
									<span className="ml-1.5 text-muted-foreground">
										{format(band[0])}–{format(band[1])}
									</span>
								)}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Axis ticks and tooltip headings: elapsed time, or clock times in the display time zone. */
function timeFormats(
	locale: string,
	timeZone: string,
	span: number,
	elapsed: ((ms: number) => string) | undefined,
) {
	if (elapsed) return { tick: elapsed, heading: elapsed };
	const time = new Intl.DateTimeFormat(locale, {
		timeZone,
		...(span > 86_400_000
			? { month: "short", day: "numeric" }
			: { hour: "2-digit", minute: "2-digit" }),
	});
	const full = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone,
	});
	return {
		tick: (value: number) => time.format(value),
		heading: (value: number) => full.format(value),
	};
}

export type ChartType = "auto" | "line" | "area" | "bar" | "stacked";
const MAX_VALUE_LABELS = 16;

export function TimeseriesChart({
	series,
	bucketSeconds,
	format,
	label,
	className,
	type = "auto",
	logScale = false,
	beginAtZero = true,
	goal,
	domain,
	bands = [],
	bandLabel,
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
	elapsed,
}: {
	series: ChartSeries[];
	bucketSeconds: number;
	format: (value: number) => string;
	label: string;
	className?: string;
	/** `auto` fills a single series and draws several as lines. */
	type?: ChartType;
	logScale?: boolean;
	beginAtZero?: boolean;
	/** A dashed horizontal reference line. */
	goal?: number;
	/** The time axis bounds in ms; defaults to the data's extent. */
	domain?: [number, number];
	/** Shaded time spans, such as periods when no node reported. */
	bands?: { from: number; to: number }[];
	bandLabel?: string;
	/** Why a series has no value in a bucket, shown in the tooltip. */
	gapLabel?: (key: string, bucketMs: number) => string | null;
	/** Dragging across the chart selects a span, from the first bucket's start to the last one's end. */
	onZoom?: (from: number, to: number) => void;
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
	/** Formats bucket times as elapsed time instead of clock times. */
	elapsed?: (ms: number) => string;
}) {
	const gradient = useId().replace(/:/g, "");
	const timeZone = useDisplayTimeZone();
	// Opacity for a series: faded while another one is highlighted.
	const emphasis = (key: string) =>
		highlight === null || highlight === key ? 1 : 0.15;
	const [selection, setSelection] = useState<{
		start: number;
		end: number;
	} | null>(null);
	const bucketAt = (state: { activeLabel?: unknown } | null | undefined) => {
		const at = Number(state?.activeLabel);
		return Number.isFinite(at) ? at : null;
	};
	const finishZoom = () => {
		if (selection && selection.start !== selection.end)
			onZoom?.(
				Math.min(selection.start, selection.end),
				Math.max(selection.start, selection.end) + bucketSeconds * 1000,
			);
		setSelection(null);
	};
	const locale = getLocale();
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
	const curve = smooth ? "monotone" : "linear";
	// A single current series gets a soft area; several stay lines so fills never overlap.
	const filled = type === "area" || (type === "auto" && current.length === 1);
	const bars = type === "bar" || type === "stacked";
	const span = rows.length
		? (rows.at(-1)?.bucketMs ?? 0) - (rows[0]?.bucketMs ?? 0)
		: 0;
	const { tick, heading } = timeFormats(locale, timeZone, span, elapsed);
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
						? format(value)
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
		if (bars)
			return (
				<Bar
					key={entry.key}
					dataKey={entry.key}
					fill={entry.color}
					fillOpacity={emphasis(entry.key)}
					stackId={type === "stacked" ? "stack" : undefined}
					radius={type === "stacked" ? 0 : [3, 3, 0, 0]}
					isAnimationActive={false}
				>
					{values(entry)}
				</Bar>
			);
		if (filled)
			return (
				<Area
					key={entry.key}
					dataKey={entry.key}
					type={curve}
					stroke={entry.color}
					strokeOpacity={emphasis(entry.key)}
					strokeWidth={2}
					fill={current.length === 1 ? `url(#${gradient})` : entry.color}
					fillOpacity={(current.length === 1 ? 1 : 0.12) * emphasis(entry.key)}
					dot={false}
					activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
					isAnimationActive={false}
				>
					{values(entry)}
				</Area>
			);
		return (
			<Line
				key={entry.key}
				dataKey={entry.key}
				type={curve}
				stroke={entry.color}
				strokeOpacity={emphasis(entry.key)}
				strokeWidth={2}
				dot={false}
				activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
				isAnimationActive={false}
			>
				{values(entry)}
			</Line>
		);
	};
	return (
		<div
			className={cn(
				"flex gap-3",
				legend && legendPosition === "right" ? "flex-row" : "flex-col",
				className,
			)}
		>
			<ChartContainer
				config={config}
				className={cn(
					"aspect-auto w-full min-w-0",
					// Beside a legend on the right it shares the row; stacked, it keeps its height.
					legend && legendPosition === "right" && "flex-1",
					height,
					onZoom && "cursor-crosshair select-none",
				)}
				role="img"
				aria-label={label}
			>
				<ComposedChart
					data={rows}
					// Side-by-side bars keep most of a narrow bucket instead of spending it on gaps.
					barGap={1}
					barCategoryGap="8%"
					margin={{
						left: yLabel ? 16 : 4,
						right: 12,
						top: showValues ? 18 : 8,
						bottom: xLabel ? 16 : 0,
					}}
					onMouseDown={(state) => {
						const at = bucketAt(state);
						if (onZoom && at !== null) setSelection({ start: at, end: at });
					}}
					onMouseMove={(state) => {
						const at = bucketAt(state);
						if (selection && at !== null)
							setSelection({ ...selection, end: at });
					}}
					onMouseUp={finishZoom}
					onMouseLeave={() => setSelection(null)}
				>
					<defs>
						<linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
							<stop
								offset="0%"
								stopColor={current[0]?.color}
								stopOpacity={0.22}
							/>
							<stop
								offset="100%"
								stopColor={current[0]?.color}
								stopOpacity={0}
							/>
						</linearGradient>
					</defs>
					<CartesianGrid vertical={false} strokeDasharray="3 4" />
					{bands.map((band) => (
						<ReferenceArea
							key={band.from}
							x1={band.from}
							x2={band.to}
							fill="var(--muted-foreground)"
							fillOpacity={0.08}
							strokeOpacity={0}
							ifOverflow="hidden"
							label={
								bandLabel && band.to - band.from >= (span || 1) / 12
									? {
											value: bandLabel,
											position: "insideTop",
											fontSize: 11,
											fill: "var(--muted-foreground)",
										}
									: undefined
							}
						/>
					))}
					{selection && selection.start !== selection.end && (
						<ReferenceArea
							x1={Math.min(selection.start, selection.end)}
							x2={Math.max(selection.start, selection.end)}
							fill="var(--primary)"
							fillOpacity={0.12}
							stroke="var(--primary)"
							strokeOpacity={0.4}
							ifOverflow="hidden"
						/>
					)}
					<XAxis
						dataKey="bucketMs"
						type="number"
						scale="time"
						domain={domain ?? ["dataMin", "dataMax"]}
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={56}
						tickFormatter={tick}
						label={
							xLabel
								? {
										value: xLabel,
										position: "insideBottom",
										offset: -12,
										fontSize: 11,
										fill: "var(--muted-foreground)",
									}
								: undefined
						}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickCount={5}
						// Sized to the widest tick label.
						width="auto"
						// A log axis cannot start at zero; non-positive values fall outside it.
						scale={logScale ? "log" : "auto"}
						domain={[
							logScale || !beginAtZero ? "auto" : 0,
							yMax !== undefined && Number.isFinite(yMax) ? yMax : "auto",
						]}
						allowDataOverflow={logScale || yMax !== undefined}
						tickFormatter={(value: number) => format(value)}
						label={
							yLabel
								? {
										value: yLabel,
										angle: -90,
										position: "insideLeft",
										offset: -8,
										fontSize: 11,
										fill: "var(--muted-foreground)",
										style: { textAnchor: "middle" },
									}
								: undefined
						}
					/>
					{goal !== undefined && Number.isFinite(goal) && (
						<ReferenceLine
							y={goal}
							stroke="var(--muted-foreground)"
							strokeDasharray="6 4"
							ifOverflow="extendDomain"
						/>
					)}
					<Tooltip
						isAnimationActive={false}
						cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
						content={(props) => (
							<TooltipCard
								{...props}
								series={drawn}
								format={format}
								gapLabel={gapLabel}
								formatTime={heading}
							/>
						)}
					/>
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
				</ComposedChart>
			</ChartContainer>
			{legend && (series.length > 1 || current.length > 1) && (
				<ul
					className={cn(
						"flex gap-x-4 gap-y-1 text-xs text-muted-foreground",
						legendPosition === "right"
							? "w-40 shrink-0 flex-col justify-center overflow-y-auto"
							: "flex-wrap justify-center",
					)}
				>
					{series.map((entry) => (
						<li key={entry.key} className="flex items-center gap-1.5">
							<svg
								aria-hidden="true"
								width="14"
								height="4"
								className="shrink-0"
							>
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
			)}
		</div>
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
