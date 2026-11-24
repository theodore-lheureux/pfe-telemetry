import { getLocale } from "@recount/i18n/runtime";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import {
	CartesianGrid,
	ComposedChart,
	ReferenceArea,
	ReferenceLine,
	Tooltip,
	usePlotArea,
	XAxis,
	YAxis,
} from "recharts";
import { useDisplayTimeZone } from "../components/time-display";
import { type ChartConfig, ChartContainer } from "../components/ui/chart";
import { cn } from "../lib/utils";

export type ChartBand = {
	from: number;
	to: number;
	label: string;
	hatched?: boolean;
	detail?: string;
};

export interface TimelineContext {
	domain?: [number, number];
	bands?: ChartBand[];
	onZoom?: (from: number, to: number) => void;
}

/** A bucket's time span, with its date only when that is not today. */
export function bucketTitle(
	start: number,
	step: number,
	locale: string,
	timeZone: string,
) {
	if (step >= 86_400_000)
		return new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			timeZone,
		}).formatRange(start, start + step - 1);
	const day = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeZone });
	return new Intl.DateTimeFormat(locale, {
		...(day.format(start) === day.format(Date.now())
			? {}
			: { dateStyle: "medium" }),
		timeStyle: step < 60_000 ? "medium" : "short",
		timeZone,
	}).formatRange(start, start + step);
}

export function axisTime(locale: string, timeZone: string, span: number) {
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		...(span > 86_400_000
			? { month: "short", day: "numeric" }
			: { hour: "2-digit", minute: "2-digit" }),
	});
}

export function ChartTooltipCard({
	title,
	note,
	children,
	maxWidth,
}: {
	title: string;
	note?: string;
	children: ReactNode;
	maxWidth?: number;
}) {
	return (
		<div
			className="grid min-w-0 gap-1.5 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground tabular-nums shadow-md"
			style={{ maxWidth }}
		>
			<p className="text-muted-foreground">{title}</p>
			{note && <p className="text-muted-foreground">{note}</p>}
			{children}
		</div>
	);
}

type TooltipContent = (
	bucketMs: number,
	row: Record<string, unknown>,
) => ReactNode;

function BucketTooltip({
	active,
	payload,
	label,
	content,
	step,
	bands,
	timeZone,
}: {
	active?: boolean;
	payload?: readonly { payload?: unknown }[];
	label?: unknown;
	content: TooltipContent;
	step: number;
	bands: ChartBand[];
	timeZone: string;
}) {
	const plot = usePlotArea();
	if (!active || typeof label !== "number") return null;
	const row = (payload?.[0]?.payload ?? {}) as Record<string, unknown>;
	const shown = content(label, row);
	if (!shown) return null;
	const band = bands.find((band) => label >= band.from && label < band.to);
	return (
		<ChartTooltipCard
			title={bucketTitle(label, step, getLocale(), timeZone)}
			note={band && (band.detail ?? band.label)}
			maxWidth={plot?.width}
		>
			{shown}
		</ChartTooltipCard>
	);
}

function CoverageHatch({ id }: { id: string }) {
	return (
		<pattern
			id={id}
			width="6"
			height="6"
			patternUnits="userSpaceOnUse"
			patternTransform="rotate(45)"
		>
			<path
				d="M 0 0 V 6"
				stroke="var(--muted-foreground)"
				strokeOpacity={0.2}
			/>
		</pattern>
	);
}

/** Time and value axes, tooltip and zoom shared by plots with different marks. */
export function TimePlot({
	rows,
	label,
	className,
	config,
	height,
	step,
	domain,
	bands = [],
	onZoom,
	xLabel,
	yLabel,
	axis,
	goal,
	showValues,
	legend,
	legendOnRight,
	definitions,
	tooltip,
	children,
}: TimelineContext & {
	rows: { bucketMs: number }[];
	label: string;
	className?: string;
	config: ChartConfig;
	height: string;
	step: number;
	xLabel?: string;
	yLabel?: string;
	axis: ComponentProps<typeof YAxis>;
	goal?: number;
	showValues?: boolean;
	legend?: ReactNode;
	legendOnRight?: boolean;
	definitions?: ReactNode;
	tooltip: TooltipContent;
	children: ReactNode;
}) {
	const hatch = useId().replace(/:/g, "");
	const timeZone = useDisplayTimeZone();
	const span = (rows.at(-1)?.bucketMs ?? 0) - (rows[0]?.bucketMs ?? 0);
	const time = axisTime(getLocale(), timeZone, span);
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
				Math.max(selection.start, selection.end) + step,
			);
		setSelection(null);
	};
	return (
		<div
			className={cn(
				"flex gap-3",
				legendOnRight ? "flex-row" : "flex-col",
				className,
			)}
		>
			<ChartContainer
				config={config}
				className={cn(
					"aspect-auto w-full min-w-0",
					legendOnRight && "flex-1",
					height,
					onZoom && "cursor-crosshair select-none",
				)}
				role="img"
				aria-label={label}
			>
				<ComposedChart
					data={rows}
					barGap={1}
					barCategoryGap="8%"
					margin={{
						left: yLabel ? 16 : 4,
						right: 12,
						top: showValues ? 18 : 12,
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
						<CoverageHatch id={hatch} />
						{definitions}
					</defs>
					<CartesianGrid vertical={false} strokeDasharray="3 4" />
					{bands.map((band) => (
						<ReferenceArea
							key={band.from}
							x1={band.from}
							x2={band.to}
							fill={band.hatched ? `url(#${hatch})` : "var(--muted-foreground)"}
							fillOpacity={band.hatched ? 1 : 0.08}
							strokeOpacity={0}
							ifOverflow="hidden"
							label={
								band.to - band.from >= (span || 1) / 12
									? {
											value: band.label,
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
						width="auto"
						{...axis}
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
						filterNull={false}
						cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
						content={(props) => (
							<BucketTooltip
								{...props}
								step={step}
								content={tooltip}
								bands={bands}
								timeZone={timeZone}
							/>
						)}
					/>
					{children}
				</ComposedChart>
			</ChartContainer>
			{legend}
		</div>
	);
}
