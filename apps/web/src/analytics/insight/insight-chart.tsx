import { m } from "@recount/i18n/messages";
import { ChartNoAxesColumnIcon, RefreshCwIcon } from "lucide-react";
import { TimeDisplay } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { IconEmptyState } from "../../components/workspace";
import { type ChartSeries, TimeseriesChart } from "../charts";
import type { QueryResult, SeriesResult } from "../contracts";
import { StatCard } from "../stat-card";
import type { Display } from "./draft";
import { bucketGrid, offlineBands, onGrid, online } from "./grid";
import { type FormulaNames, plottedTitle } from "./labels";
import {
	CHART_SERIES,
	identity,
	lineId,
	type SeriesView,
	stats,
} from "./series-view";

/** Why a series has no value in a bucket: its node, or any node when not grouped by node. */
function gapReason(
	result: QueryResult,
	series: SeriesResult,
	bucketMs: number,
) {
	if (series.comparison) return m.insight_gap_unknown();
	const node =
		result.groupBy[0] === "node" && !series.other ? series.group[0] : undefined;
	const state = online(result.coverage, bucketMs, node);
	if (state === null) return m.insight_gap_unknown();
	return state ? m.insight_gap_online() : m.insight_gap_offline();
}

/** The chart or stat cards for a query result, with when it was computed. */
export function InsightChart({
	result,
	view,
	display,
	hydrated,
	fetching,
	computedAt,
	names,
	onRefresh,
	onZoom,
	highlight,
}: {
	result: QueryResult;
	view: SeriesView;
	display: Display;
	hydrated: boolean;
	fetching: boolean;
	/** Null while a newer result loads. */
	computedAt: Date | null;
	names: FormulaNames;
	onRefresh: () => void;
	/** Narrows the time range to a span dragged across the chart. */
	onZoom: (from: Date, to: Date) => void;
	/** The line hovered in the results table. */
	highlight: string | null;
}) {
	const title = plottedTitle(result, names);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<div className="flex min-w-0 flex-col gap-0.5">
					{title && (
						<h2 className="truncate text-sm font-medium text-foreground">
							{title}
						</h2>
					)}
					<span className="flex items-center gap-1">
						{fetching || !computedAt ? (
							m.insight_updating()
						) : (
							<>
								{m.insight_computed()}{" "}
								<TimeDisplay value={computedAt} mode="relative" />
							</>
						)}
					</span>
				</div>
				<Button
					variant="ghost"
					size="sm"
					disabled={!hydrated || fetching}
					onClick={onRefresh}
				>
					<RefreshCwIcon
						aria-hidden="true"
						className={fetching ? "motion-safe:animate-spin" : ""}
					/>
					{m.overview_refresh()}
				</Button>
			</div>
			<ChartBody
				result={result}
				view={view}
				display={display}
				hydrated={hydrated}
				fetching={fetching}
				onZoom={onZoom}
				highlight={highlight}
			/>
			{view.current.length > CHART_SERIES && display.type !== "table" && (
				<p className="text-xs text-muted-foreground">
					{m.insight_chart_limited()}
				</p>
			)}
		</div>
	);
}

function ChartBody({
	result,
	view,
	display,
	hydrated,
	fetching,
	onZoom,
	highlight,
}: {
	result: QueryResult;
	view: SeriesView;
	display: Display;
	hydrated: boolean;
	fetching: boolean;
	onZoom: (from: Date, to: Date) => void;
	highlight: string | null;
}) {
	if (view.empty)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.insight_empty_result()}
				className="h-72"
			/>
		);
	// The table below the chart already shows a table-shaped result.
	if (display.type === "table") return null;
	if (!hydrated) return <Skeleton className="h-72 w-full" />;
	const bucketSeconds = result.bucketSeconds ?? 60;
	const grid = bucketGrid(result.from, result.to, bucketSeconds);
	const pointsOf = (series: SeriesResult) =>
		onGrid(
			series.points.flatMap((point) =>
				point.bucketMs === null
					? []
					: [{ bucketMs: point.bucketMs, value: point.value }],
			),
			grid,
		);
	if (display.type === "stat")
		return (
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{view.charted.map((series) => (
					<StatCard
						key={identity(series)}
						loading={fetching}
						title={view.label(series)}
						value={view.format(series)(stats(series).latest)}
						points={pointsOf(series)}
						bucketSeconds={bucketSeconds}
						color={view.color(series)}
						hydrated={hydrated}
					/>
				))}
			</div>
		);
	const charting = view.visible.filter((series) => view.color(series));
	const chartSeries: ChartSeries[] = charting.map((series, index) => ({
		key: `s${index}`,
		label: view.label(series),
		color: view.color(series) ?? "var(--viz-1)",
		comparison: series.comparison,
		points: pointsOf(series),
	}));
	const bands = offlineBands(grid, result.coverage, bucketSeconds * 1000);
	return (
		<TimeseriesChart
			label={m.insight_chart_label()}
			series={chartSeries}
			bucketSeconds={bucketSeconds}
			format={view.format(view.current[0])}
			type={display.type}
			logScale={display.logScale}
			beginAtZero={display.beginAtZero}
			goal={display.goal}
			domain={[
				grid[0] ?? result.from.getTime(),
				grid.at(-1) ?? result.to.getTime(),
			]}
			bands={bands}
			bandLabel={m.insight_offline()}
			onZoom={(from, to) => onZoom(new Date(from), new Date(to))}
			// The results table names every line, and the tooltip names them on hover.
			legend={false}
			highlight={
				chartSeries.find((_, index) => lineId(charting[index]) === highlight)
					?.key ?? null
			}
			gapLabel={(key, bucketMs) => {
				const series = charting[Number(key.slice(1))];
				return series
					? gapReason(result, series, bucketMs)
					: m.insight_gap_unknown();
			}}
		/>
	);
}
