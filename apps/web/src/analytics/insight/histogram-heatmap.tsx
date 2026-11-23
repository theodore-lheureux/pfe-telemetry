import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useState } from "react";
import { ScatterChart, usePlotArea, XAxis, YAxis } from "recharts";
import { ChartContainer } from "../../components/ui/chart";
import {
	type HistogramWindow,
	heatColor,
	histogramFormatter,
} from "../histograms";

interface Timeline {
	from: number;
	to: number;
	step: number;
}

export function HistogramHeatmap({
	rows,
	unit,
	metric,
	limited,
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
	metric: string;
	limited: boolean;
	zone: string;
	timeline: Timeline;
}) {
	const layouts = new Map<string, HistogramWindow[]>();
	for (const row of rows) {
		const key = JSON.stringify(row.bounds);
		const layout = layouts.get(key);
		if (layout) layout.push(row);
		else layouts.set(key, [row]);
	}
	if (!rows.length) return <p>{m.histogram_empty()}</p>;
	return (
		<div className="space-y-4">
			{limited && <p role="status">{m.histogram_limited()}</p>}
			{[...layouts].map(([key, windows]) => (
				<HeatmapLayout
					key={`${timeline.from}:${key}`}
					rows={windows}
					unit={unit}
					metric={metric}
					zone={zone}
					timeline={timeline}
				/>
			))}
		</div>
	);
}

function HeatmapLayout({
	rows,
	unit,
	metric,
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
	metric: string;
	zone: string;
	timeline: Timeline;
}) {
	const locale = getLocale();
	const { from, to } = timeline;
	const bounds = rows[0].bounds;
	const occupied = rows[0].counts.flatMap((_, i) =>
		rows.some((row) => Number(row.counts[i]) > 0) ? [i] : [],
	);
	const first = Math.max(0, (occupied[0] ?? 0) - 1);
	const last = Math.min(bounds.length, (occupied.at(-1) ?? 0) + 1);
	const size = last - first + 1;
	const number = new Intl.NumberFormat(locale);
	const format = histogramFormatter(
		unit,
		metric,
		locale,
		Math.max(0, ...bounds.map(Math.abs)),
	);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: zone,
	});
	const detailTime = new Intl.DateTimeFormat(locale, {
		dateStyle: "short",
		timeStyle: "medium",
		timeZone: zone,
	});
	const [hover, setHover] = useState<{
		x: number;
		y: number;
		text: string;
	} | null>(null);
	const bucketTicks = Array.from({ length: size }, (_, index) => index + 0.5);
	return (
		<figure className="min-w-0 space-y-2">
			<figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>{m.histogram_bucket()}</span>
				<span className="flex items-center gap-2">
					{m.histogram_intensity()}
					<span
						aria-hidden="true"
						className="h-2 w-24 rounded-sm bg-[linear-gradient(to_right,var(--muted),var(--chart-1))]"
					/>
				</span>
			</figcaption>
			<ChartContainer
				config={{}}
				className="aspect-auto w-full"
				style={{ height: Math.max(180, size * 20 + 36) }}
			>
				<ScatterChart
					accessibilityLayer={false}
					margin={{ top: 4, right: 18, bottom: 0, left: 0 }}
					aria-label={m.histogram_title()}
				>
					<XAxis
						type="number"
						scale="linear"
						domain={[from, to]}
						tick={false}
						height={28}
						allowDataOverflow
					/>
					<YAxis
						type="number"
						domain={[0, size]}
						width={112}
						ticks={bucketTicks}
						interval={0}
						tickFormatter={(value) =>
							format.range(bounds, first + Math.floor(value))
						}
						allowDataOverflow
					/>
					<HeatmapCells
						rows={rows.map((row) => ({
							...row,
							counts: row.counts.slice(first, last + 1),
						}))}
						timeline={timeline}
						range={(index) => format.range(bounds, first + index)}
						time={(value) => detailTime.format(value)}
						count={(value) => number.format(BigInt(value))}
						onHover={(x, y, start, index, value) => {
							const total =
								rows
									.find((row) => Number(row.bucket) === start)
									?.counts.reduce((sum, count) => sum + Number(count), 0) ?? 0;
							const share = new Intl.NumberFormat(locale, {
								style: "percent",
								maximumFractionDigits: 1,
							}).format(total ? Number(value) / total : 0);
							const interval = detailTime.formatRange(
								Math.max(start, from),
								Math.min(start + timeline.step, to),
							);
							setHover({
								x,
								y,
								text: `${interval} · ${format.range(bounds, first + index)} · ${m.histogram_count()}: ${number.format(BigInt(value))} · ${m.histogram_column_share({ share })}`,
							});
						}}
						onLeave={() => setHover(null)}
					/>
					<TimeTicks
						from={from}
						to={to}
						format={(value) => time.format(value)}
					/>
				</ScatterChart>
			</ChartContainer>
			{hover && (
				<div
					role="tooltip"
					className="pointer-events-none fixed z-50 max-w-80 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
					style={{
						left: Math.min(hover.x + 12, window.innerWidth - 330),
						top: Math.max(4, hover.y - 64),
					}}
				>
					{hover.text}
				</div>
			)}
		</figure>
	);
}

function TimeTicks({
	from,
	to,
	format,
}: {
	from: number;
	to: number;
	format: (value: number) => string;
}) {
	const area = usePlotArea();
	if (!area) return null;
	const divisions = area.width < 360 ? 2 : 4;
	return (
		<g data-time-axis className="fill-muted-foreground text-xs">
			{Array.from({ length: divisions + 1 }, (_, i) => {
				const ratio = i / divisions;
				const value = from + (to - from) * ratio;
				let anchor: "start" | "middle" | "end" = "middle";
				if (i === 0) anchor = "start";
				if (i === divisions) anchor = "end";
				return (
					<text
						key={value}
						x={area.x + area.width * ratio}
						y={area.y + area.height + 17}
						textAnchor={anchor}
					>
						{format(value)}
					</text>
				);
			})}
		</g>
	);
}

function HeatmapCells({
	rows,
	timeline,
	range,
	time,
	count,
	onHover,
	onLeave,
}: {
	rows: HistogramWindow[];
	timeline: Timeline;
	range: (index: number) => string;
	time: (value: number) => string;
	count: (value: string) => string;
	onHover: (
		x: number,
		y: number,
		start: number,
		index: number,
		value: string,
	) => void;
	onLeave: () => void;
}) {
	const area = usePlotArea();
	if (!area) return null;
	const { from, to, step } = timeline;
	const height = area.height / rows[0].counts.length;
	const position = (value: number) =>
		area.x + ((value - from) * area.width) / (to - from);
	const peak = Math.max(
		1,
		...rows.map((row) => Math.max(...row.counts.map(Number))),
	);
	return (
		<g>
			{rows.map((row) => {
				const start = Number(row.bucket);
				const x = position(Math.max(start, from));
				const width = position(Math.min(start + step, to)) - x;
				return (
					<g key={row.bucket} data-time-window={row.bucket}>
						{row.counts.map((value, index) => (
							<rect
								key={row.bounds[index] ?? "overflow"}
								x={x}
								y={area.y + area.height - (index + 1) * height}
								width={Math.max(0, width - 1)}
								height={Math.max(0, height - 1)}
								pointerEvents="all"
								onPointerEnter={(event) =>
									onHover(event.clientX, event.clientY, start, index, value)
								}
								onPointerLeave={onLeave}
								fill={heatColor(Math.log1p(Number(value)) / Math.log1p(peak))}
							>
								<title>{`${time(start)} · ${range(index)} · ${m.histogram_count()}: ${count(value)}`}</title>
							</rect>
						))}
					</g>
				);
			})}
		</g>
	);
}
