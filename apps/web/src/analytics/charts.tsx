import { getLocale } from "@recount/i18n/runtime";
import { useId, useMemo, useState } from "react";
import {
	Area,
	Bar,
	CartesianGrid,
	ComposedChart,
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

export interface ChartPoint {
	bucketMs: number;
	value: number | null;
}

export interface ChartSeries {
	key: string;
	label: string;
	/** A CSS color, normally one of the fixed `--viz-N` categorical slots. */
	color: string;
	points: ChartPoint[];
	/** A comparison line, such as the previous period: lighter and dashed. */
	comparison?: boolean;
}

const TAIL = "~tail";

/**
 * Splits each current series into a solid part and a dashed tail for a bucket that is
 * still filling, so a partial value does not read as a real drop.
 */
function chartRows(series: ChartSeries[], bucketMs: number, now: number) {
	const rows = new Map<number, Record<string, number | null>>();
	for (const entry of series) {
		const points = entry.points.filter((point) => point.value !== null);
		const last = points.at(-1);
		const partial =
			!entry.comparison && last !== undefined && last.bucketMs + bucketMs > now;
		for (const point of entry.points) {
			const row = rows.get(point.bucketMs) ?? { bucketMs: point.bucketMs };
			row[entry.key] = partial && point === last ? null : (point.value ?? null);
			rows.set(point.bucketMs, row);
		}
		if (partial && last) {
			const previous = points.at(-2);
			for (const point of [previous, last])
				if (point) {
					const row = rows.get(point.bucketMs);
					if (row) row[`${entry.key}${TAIL}`] = point.value;
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
	timeZone,
}: {
	active?: boolean;
	payload?: readonly { payload?: unknown }[];
	label?: unknown;
	series: ChartSeries[];
	format: (value: number) => string;
	gapLabel?: (key: string, bucketMs: number) => string | null;
	timeZone: string;
}) {
	if (!active || !payload?.length || typeof label !== "number") return null;
	const row = payload[0]?.payload as Record<string, number | null>;
	const locale = getLocale();
	return (
		<div className="grid min-w-44 gap-1.5 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
			<p className="font-medium">
				{new Intl.DateTimeFormat(locale, {
					dateStyle: "medium",
					timeStyle: "short",
					timeZone,
				}).format(label)}
			</p>
			{series.map((entry) => {
				const value = row[entry.key] ?? row[`${entry.key}${TAIL}`] ?? null;
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
							<span className="font-mono tabular-nums">{format(value)}</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

export type ChartType = "auto" | "line" | "area" | "bar" | "stacked";

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
	highlight = null,
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
	/** Lists the series under the chart; off when a table beside it already names them. */
	legend?: boolean;
	/** A series key to emphasize; the others fade. */
	highlight?: string | null;
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
	const rows = useMemo(
		() => chartRows(series, bucketSeconds * 1000, now),
		[series, bucketSeconds, now],
	);
	const current = series.filter((entry) => !entry.comparison);
	// A single current series gets a soft area; several stay lines so fills never overlap.
	const filled = type === "area" || (type === "auto" && current.length === 1);
	const bars = type === "bar" || type === "stacked";
	const span = rows.length
		? (rows.at(-1)?.bucketMs ?? 0) - (rows[0]?.bucketMs ?? 0)
		: 0;
	// Times read in the display time zone, like every other time in the app.
	const time = new Intl.DateTimeFormat(locale, {
		timeZone,
		...(span > 86_400_000
			? { month: "short", day: "numeric" }
			: { hour: "2-digit", minute: "2-digit" }),
	});
	const config = Object.fromEntries(
		series.map((entry) => [
			entry.key,
			{ label: entry.label, color: entry.color },
		]),
	) satisfies ChartConfig;
	return (
		<div className={cn("flex flex-col gap-3", className)}>
			<ChartContainer
				config={config}
				className={cn(
					"aspect-auto h-72 w-full",
					onZoom && "cursor-crosshair select-none",
				)}
				role="img"
				aria-label={label}
			>
				<ComposedChart
					data={rows}
					margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
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
						tickFormatter={(value: number) => time.format(value)}
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickCount={5}
						width={72}
						// A log axis cannot start at zero; non-positive values fall outside it.
						scale={logScale ? "log" : "auto"}
						domain={
							logScale
								? ["auto", "auto"]
								: beginAtZero
									? [0, "auto"]
									: ["auto", "auto"]
						}
						allowDataOverflow={logScale}
						tickFormatter={(value: number) => format(value)}
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
						cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
						content={(props) => (
							<TooltipCard
								{...props}
								series={series}
								format={format}
								gapLabel={gapLabel}
								timeZone={timeZone}
							/>
						)}
					/>
					{series.map((entry) =>
						entry.comparison ? (
							<Line
								key={entry.key}
								dataKey={entry.key}
								type="linear"
								stroke={entry.color}
								strokeOpacity={0.45 * emphasis(entry.key)}
								strokeWidth={2}
								strokeDasharray="4 4"
								dot={false}
								isAnimationActive={false}
							/>
						) : bars ? (
							<Bar
								key={entry.key}
								dataKey={entry.key}
								fill={entry.color}
								fillOpacity={emphasis(entry.key)}
								stackId={type === "stacked" ? "stack" : undefined}
								radius={type === "stacked" ? 0 : [3, 3, 0, 0]}
								isAnimationActive={false}
							/>
						) : filled ? (
							<Area
								key={entry.key}
								dataKey={entry.key}
								type="linear"
								stroke={entry.color}
								strokeOpacity={emphasis(entry.key)}
								strokeWidth={2}
								fill={current.length === 1 ? `url(#${gradient})` : entry.color}
								fillOpacity={
									(current.length === 1 ? 1 : 0.12) * emphasis(entry.key)
								}
								dot={false}
								activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
								isAnimationActive={false}
							/>
						) : (
							<Line
								key={entry.key}
								dataKey={entry.key}
								type="linear"
								stroke={entry.color}
								strokeOpacity={emphasis(entry.key)}
								strokeWidth={2}
								dot={false}
								activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
								isAnimationActive={false}
							/>
						),
					)}
					{(bars ? [] : current).map((entry) => (
						<Line
							key={`${entry.key}${TAIL}`}
							dataKey={`${entry.key}${TAIL}`}
							type="linear"
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
				<ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
}: {
	points: ChartPoint[];
	bucketSeconds: number;
	color?: string;
}) {
	const gradient = useId().replace(/:/g, "");
	const now = Date.now();
	const rows = useMemo(
		() =>
			chartRows(
				[{ key: "value", label: "", color, points }],
				bucketSeconds * 1000,
				now,
			),
		[points, bucketSeconds, color, now],
	);
	return (
		<ChartContainer
			config={{ value: { color } }}
			className="aspect-auto h-12 w-full"
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
				<YAxis hide domain={["dataMin", "dataMax"]} />
				<Area
					dataKey="value"
					type="linear"
					stroke={color}
					strokeWidth={1.5}
					fill={`url(#${gradient})`}
					dot={false}
					isAnimationActive={false}
				/>
				<Line
					dataKey={`value${TAIL}`}
					type="linear"
					stroke={color}
					strokeWidth={1.5}
					strokeDasharray="3 3"
					dot={false}
					isAnimationActive={false}
				/>
			</ComposedChart>
		</ChartContainer>
	);
}
