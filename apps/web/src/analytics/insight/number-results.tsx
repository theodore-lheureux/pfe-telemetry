import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { type ChartPoint, Sparkline } from "../charts";
import type { SeriesResult } from "../contracts";
import type { Display } from "./draft";
import { identity, type SeriesView, stats } from "./series-view";

export function numberComparison(
	current: number | null,
	previous: number | null,
) {
	if (current === null || previous === null || previous === 0) return null;
	const change = (current - previous) / Math.abs(previous);
	return Number.isFinite(change) ? change : null;
}

function Change({ value }: { value: number | null }) {
	if (value === null) return null;
	const Icon = value < 0 ? ArrowDownIcon : ArrowUpIcon;
	return (
		<Badge variant="secondary" className="shrink-0 gap-0.5 tabular-nums">
			<Icon aria-hidden="true" className="size-3" />
			{new Intl.NumberFormat(getLocale(), {
				style: "percent",
				maximumFractionDigits: 1,
				signDisplay: "exceptZero",
			}).format(value)}
		</Badge>
	);
}

export function NumberResults({
	view,
	display,
	pointsOf,
	bucketSeconds,
	compact,
	height,
}: {
	view: SeriesView;
	display: Display;
	pointsOf: (series: SeriesResult) => ChartPoint[];
	bucketSeconds: number;
	compact: boolean;
	height: string;
}) {
	const chart = display.numberChart ?? "area";
	const series = view.charted[0];
	if (!series) return null;
	const value = stats(series).latest;
	const comparison = view.visible.find(
		(candidate) =>
			candidate.comparison && identity(candidate) === identity(series),
	);
	const previous = comparison ? stats(comparison).latest : null;
	const change = numberComparison(value, previous);
	const format = view.format(series);
	const centered = !compact || !comparison;
	return (
		<div
			className={cn(
				"relative flex min-h-0 min-w-0 flex-col overflow-hidden",
				height,
				centered && "items-center justify-center",
			)}
		>
			<div
				className={cn(
					"relative z-10 flex min-w-0 flex-col",
					compact ? "w-full gap-1 px-3 py-1.5" : "gap-2 px-6 py-8",
					centered && "items-center",
				)}
			>
				<div className="flex min-w-0 items-center justify-between gap-3">
					<span
						className={cn(
							"min-w-0 font-semibold tracking-tight tabular-nums wrap-anywhere",
							compact ? "text-3xl @lg:text-4xl" : "text-6xl sm:text-7xl",
						)}
					>
						{format(value)}
					</span>
					<Change value={change} />
				</div>
				{comparison && (
					<p
						className={cn(
							"text-muted-foreground",
							compact ? "text-xs" : "text-sm",
						)}
					>
						{m.overview_vs_prior({ value: format(previous) })}
					</p>
				)}
			</div>
			{chart !== "none" && (
				<div
					className={cn(
						"pointer-events-none",
						compact
							? "absolute inset-x-0 bottom-0 h-1/3"
							: "absolute inset-x-0 bottom-0 h-1/3 opacity-30",
					)}
				>
					<Sparkline
						points={pointsOf(series)}
						bucketSeconds={bucketSeconds}
						color={view.color(series)}
						type={chart}
						smooth={display.lineStyle === "smooth"}
						beginAtZero={display.beginAtZero}
					/>
				</div>
			)}
		</div>
	);
}
