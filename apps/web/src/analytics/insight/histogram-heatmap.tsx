import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useState } from "react";
import { ScatterChart, usePlotArea, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent } from "../../components/ui/chart";
import {
	type HistogramWindow,
	heatColor,
	histogramFormatter,
	visibleHistogramBuckets,
} from "../histograms";
import { distributionLabels } from "../metric-names";

interface Timeline {
	from: number;
	to: number;
	step: number;
}

export function HistogramHeatmap({
	rows,
	unit,
	metric,
	label,
	limited,
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
	metric: string;
	label?: string;
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
					label={label}
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
	label,
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
	metric: string;
	label?: string;
	zone: string;
	timeline: Timeline;
}) {
	const locale = getLocale();
	const { from, to } = timeline;
	const bounds = rows[0].bounds;
	const { first, last } = visibleHistogramBuckets(rows, unit, metric);
	const { quantity, subject } = distributionLabels(metric, label);
	const size = last - first + 1;
	const number = new Intl.NumberFormat(locale);
	const format = histogramFormatter(
		unit,
		metric,
		locale,
		Math.max(
			0,
			...bounds.slice(Math.max(0, first - 1), last + 1).map(Math.abs),
		),
	);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
		...(timeline.step < 60_000 ? { second: "2-digit" } : {}),
		timeZone: zone,
	});
	const detailTime = new Intl.DateTimeFormat(locale, {
		dateStyle: "short",
		timeStyle: timeline.step < 60_000 ? "medium" : "short",
		timeZone: zone,
	});
	const day = new Intl.DateTimeFormat(locale, {
		dateStyle: "short",
		timeZone: zone,
	});
	const today = day.format(new Date());
	const percent = new Intl.NumberFormat(locale, {
		style: "percent",
		maximumFractionDigits: 1,
	});
	const [hover, setHover] = useState<{
		x: number;
		y: number;
		header: string;
		range: string;
		count: string;
	} | null>(null);
	const bucketTicks = Array.from({ length: size }, (_, index) => index + 0.5);
	return (
		<figure className="min-w-0 space-y-2">
			<figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>{quantity}</span>
				<span className="flex items-center gap-2">
					{m.histogram_intensity({ subject })}
					<span
						aria-hidden="true"
						className="h-2 w-24 rounded-sm bg-[linear-gradient(to_right,var(--muted),var(--chart-1))]"
					/>
				</span>
			</figcaption>
			<ChartContainer
				config={{ quantity: { label: quantity }, subject: { label: subject } }}
				className="aspect-auto w-full"
				style={{ height: Math.max(180, size * 20 + 36) }}
				overlay={
					hover && (
						<div
							role="tooltip"
							className="pointer-events-none fixed z-50 max-w-80"
							style={{
								left: Math.max(
									4,
									Math.min(hover.x + 12, window.innerWidth - 330),
								),
								top: Math.max(4, hover.y - 64),
							}}
						>
							<ChartTooltipContent
								active
								hideIndicator
								label={hover.header}
								payload={[
									{
										graphicalItemId: "quantity",
										name: "quantity",
										value: hover.range,
									},
									{
										graphicalItemId: "subject",
										name: "subject",
										value: hover.count,
									},
								]}
							/>
						</div>
					)
				}
			>
				<ScatterChart
					accessibilityLayer={false}
					margin={{ top: 4, right: 18, bottom: 0, left: 0 }}
					aria-label={quantity}
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
						onHover={(x, y, start, index, value) => {
							const total =
								rows
									.find((row) => Number(row.bucket) === start)
									?.counts.reduce((sum, count) => sum + Number(count), 0) ?? 0;
							const share = percent.format(total ? Number(value) / total : 0);
							const beginning = Math.max(start, from);
							const end = Math.min(start + timeline.step, to);
							const timestamp =
								day.format(beginning) === today && day.format(end) === today
									? time
									: detailTime;
							const count = number.format(BigInt(value));
							const describeCount =
								end - beginning === 60_000
									? m.histogram_minute_share
									: m.histogram_column_share;
							setHover({
								x,
								y,
								header: timestamp.formatRange(beginning, end),
								range: format.range(bounds, first + index),
								count: describeCount({ count, share }),
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
	onHover,
	onLeave,
}: {
	rows: HistogramWindow[];
	timeline: Timeline;
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
								fill={
									value === "0"
										? "transparent"
										: heatColor(Math.log1p(Number(value)) / Math.log1p(peak))
								}
							/>
						))}
					</g>
				);
			})}
		</g>
	);
}
