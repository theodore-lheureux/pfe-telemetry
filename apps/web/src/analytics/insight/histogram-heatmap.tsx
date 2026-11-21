import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useState } from "react";
import { ScatterChart, usePlotArea, XAxis, YAxis } from "recharts";
import { ChartContainer } from "../../components/ui/chart";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select";
import { type HistogramWindow, histogramRange } from "../histograms";

interface Timeline {
	from: number;
	to: number;
	step: number;
}

export function HistogramHeatmap({
	rows,
	unit,
	limited,
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
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
	zone,
	timeline,
}: {
	rows: HistogramWindow[];
	unit: string;
	zone: string;
	timeline: Timeline;
}) {
	const locale = getLocale();
	const { from, to } = timeline;
	const [activeBucket, setActiveBucket] = useState(rows.at(-1)?.bucket ?? "");
	const active = rows.find((row) => row.bucket === activeBucket) ?? rows[0];
	const bounds = rows[0].bounds;
	const size = bounds.length + 1;
	const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 });
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
	const tickInterval = Math.ceil(size / 8);
	const bucketTicks = Array.from(
		{ length: size },
		(_, index) => index + 0.5,
	).filter((_, index) => index % tickInterval === 0 || index === size - 1);
	return (
		<figure className="min-w-0 space-y-2">
			<figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>
					{m.histogram_bucket()} {unit && `(${unit})`}
				</span>
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
				style={{ height: Math.max(220, size * 10 + 36) }}
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
						tickFormatter={(value) =>
							histogramRange(bounds, Math.floor(value), number)
						}
						allowDataOverflow
					/>
					<HeatmapCells
						rows={rows}
						timeline={timeline}
						active={active.bucket}
						range={(index) => histogramRange(bounds, index, number)}
						time={(value) => detailTime.format(value)}
						count={(value) => number.format(BigInt(value))}
					/>
					<TimeTicks
						from={from}
						to={to}
						format={(value) => time.format(value)}
					/>
				</ScatterChart>
			</ChartContainer>
			<div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
				<NativeSelect
					aria-label={m.histogram_time_slice()}
					value={active.bucket}
					onChange={(event) => setActiveBucket(event.target.value)}
				>
					{rows.map((row) => (
						<NativeSelectOption key={row.bucket} value={row.bucket}>
							{detailTime.format(Number(row.bucket))}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
					{(
						[
							[
								m.histogram_count(),
								new Intl.NumberFormat(locale).format(BigInt(active.count)),
							],
							[m.histogram_mean(), active.mean],
							[m.histogram_min(), active.min],
							[m.histogram_max(), active.max],
						] as const
					).map(([label, value]) => (
						<div key={label} className="flex gap-1.5">
							<dt className="text-muted-foreground">{label}</dt>
							<dd>
								{typeof value === "number"
									? number.format(value)
									: (value ?? "—")}
							</dd>
						</div>
					))}
				</dl>
			</div>
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
	active,
	range,
	time,
	count,
}: {
	rows: HistogramWindow[];
	timeline: Timeline;
	active: string;
	range: (index: number) => string;
	time: (value: number) => string;
	count: (value: string) => string;
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
				const x = position(start);
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
								fill={`color-mix(in oklab, var(--chart-1) ${(100 * Math.log1p(Number(value))) / Math.log1p(peak)}%, var(--muted))`}
							>
								<title>{`${time(start)} · ${range(index)} · ${count(value)}`}</title>
							</rect>
						))}
						{row.bucket === active && (
							<rect
								x={x}
								y={area.y}
								width={width}
								height={area.height}
								fill="none"
								stroke="var(--foreground)"
								pointerEvents="none"
							/>
						)}
					</g>
				);
			})}
		</g>
	);
}
