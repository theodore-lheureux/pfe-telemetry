import { getLocale } from "@recount/i18n/runtime";
import { useId, useMemo } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
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
}: {
	active?: boolean;
	payload?: readonly { payload?: unknown }[];
	label?: unknown;
	series: ChartSeries[];
	format: (value: number) => string;
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
						<span className="font-mono tabular-nums">
							{value === null ? "—" : format(value)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

export function TimeseriesChart({
	series,
	bucketSeconds,
	format,
	label,
	className,
}: {
	series: ChartSeries[];
	bucketSeconds: number;
	format: (value: number) => string;
	label: string;
	className?: string;
}) {
	const gradient = useId().replace(/:/g, "");
	const locale = getLocale();
	const now = Date.now();
	const rows = useMemo(
		() => chartRows(series, bucketSeconds * 1000, now),
		[series, bucketSeconds, now],
	);
	const current = series.filter((entry) => !entry.comparison);
	// A single current series gets a soft area; several stay lines so fills never overlap.
	const filled = current.length === 1;
	const span = rows.length
		? (rows.at(-1)?.bucketMs ?? 0) - (rows[0]?.bucketMs ?? 0)
		: 0;
	const time = new Intl.DateTimeFormat(locale, {
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
				className="aspect-auto h-72 w-full"
				role="img"
				aria-label={label}
			>
				<ComposedChart
					data={rows}
					margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
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
					<XAxis
						dataKey="bucketMs"
						type="number"
						scale="time"
						domain={["dataMin", "dataMax"]}
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
						tickFormatter={(value: number) => format(value)}
					/>
					<Tooltip
						cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
						content={(props) => (
							<TooltipCard {...props} series={series} format={format} />
						)}
					/>
					{series.map((entry) =>
						entry.comparison ? (
							<Line
								key={entry.key}
								dataKey={entry.key}
								type="linear"
								stroke={entry.color}
								strokeOpacity={0.45}
								strokeWidth={2}
								strokeDasharray="4 4"
								dot={false}
								isAnimationActive={false}
							/>
						) : filled ? (
							<Area
								key={entry.key}
								dataKey={entry.key}
								type="linear"
								stroke={entry.color}
								strokeWidth={2}
								fill={`url(#${gradient})`}
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
								strokeWidth={2}
								dot={false}
								activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
								isAnimationActive={false}
							/>
						),
					)}
					{current.map((entry) => (
						<Line
							key={`${entry.key}${TAIL}`}
							dataKey={`${entry.key}${TAIL}`}
							type="linear"
							stroke={entry.color}
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
			{(series.length > 1 || current.length > 1) && (
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
