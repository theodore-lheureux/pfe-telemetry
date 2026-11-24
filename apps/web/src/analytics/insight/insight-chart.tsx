import { formatSeconds } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { Skeleton } from "../../components/ui/skeleton";
import { IconEmptyState } from "../../components/workspace";
import { type ChartSeries, type ChartType, TimeseriesChart } from "../charts";
import type { QueryResult, SeriesResult } from "../contracts";
import { ComputedAt, RefreshButton } from "../refresh-status";
import type { Display } from "./draft";
import { bucketGrid, coverageBands, coverageState, onGrid } from "./grid";
import type { FormulaNames } from "./labels";
import {
	ChartPanel,
	chartHandlesEmpty,
	chartLimitsSeries,
	chartTitle,
} from "./panels/registry";
import type { PanelProps } from "./panels/types";
import { CHART_SERIES, lineId, type SeriesView } from "./series-view";

/** Why a series has no value in a bucket: its node, or any node when not grouped by node. */
function gapReason(
	result: QueryResult,
	series: SeriesResult,
	bucketMs: number,
	step: number,
) {
	if (series.comparison) return m.insight_gap_unknown();
	const node = series.other ? -1 : result.groupBy.indexOf("node");
	const state = coverageState(
		result.coverage,
		bucketMs,
		step,
		result.ingestedThrough,
		series.group[node],
	);
	if (state === "arriving") return null;
	if (state === "reported") return m.insight_gap_reported();
	if (state === "missing") return m.insight_no_data_received();
	return m.insight_gap_unknown();
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
	onGroup,
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
	/** Opens one group of the breakdown on its own. */
	onGroup?: (series: SeriesResult) => void;
}) {
	const title = chartTitle(display.type, result, names);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<div className="flex min-w-0 flex-col gap-0.5">
					{title && (
						<h2 className="truncate text-sm font-medium text-foreground">
							{title}
						</h2>
					)}
					<ComputedAt computedAt={computedAt} fetching={fetching} />
				</div>
				<RefreshButton
					fetching={fetching}
					disabled={!hydrated}
					onRefresh={onRefresh}
				/>
			</div>
			<ChartBody
				result={result}
				view={view}
				display={display}
				hydrated={hydrated}
				onZoom={onZoom}
				highlight={highlight}
				onGroup={onGroup}
			/>
			<ChartNote result={result} view={view} display={display} />
		</div>
	);
}

/** One note under the chart: groups cut by the limit, else lines left to the table. */
function ChartNote({
	result,
	view,
	display,
}: {
	result: QueryResult;
	view: SeriesView;
	display: Display;
}) {
	let note: string | null = null;
	if (result.limited) note = m.insight_groups_limited();
	else if (
		view.current.length > CHART_SERIES &&
		chartLimitsSeries(display.type)
	)
		note = m.insight_chart_limited();
	return note && <p className="text-xs text-muted-foreground">{note}</p>;
}

/** The plotted result: a chart, stat cards, or nothing when the table shows it. */
export function ChartBody({
	result,
	view,
	display,
	hydrated,
	onZoom,
	highlight,
	height = "h-72",
	fill = false,
	onGroup,
}: {
	result: QueryResult;
	view: SeriesView;
	display: Display;
	hydrated: boolean;
	onZoom?: (from: Date, to: Date) => void;
	highlight: string | null;
	/** The chart's height class; `h-full` fills a sized parent. */
	height?: string;
	/** Stretches stat cards across the space, as on a dashboard tile. */
	fill?: boolean;
	onGroup?: (series: SeriesResult) => void;
}) {
	const bucketSeconds = result.bucketSeconds ?? 60;
	const step = bucketSeconds * 1000;
	const watermark = result.ingestedThrough;
	const grid = bucketGrid(result.from, result.to, bucketSeconds);
	const coverage = coverageBands(grid, result.coverage, step, watermark);
	const arrivalDetail = watermark
		? m.insight_ingestion_delay({
				delay: formatSeconds(
					Math.max(0, Math.round((Date.now() - watermark.getTime()) / 1000)),
				),
			})
		: undefined;
	const emptyDetail = () => {
		if (coverage.at(-1)?.kind === "arriving") return arrivalDetail;
		if (
			coverage[0]?.from === grid[0] &&
			coverage[0]?.to === (grid.at(-1) ?? 0) + step
		)
			return m.insight_no_data_received();
	};
	if (view.empty && !chartHandlesEmpty(display.type))
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.insight_empty_result()}
				description={emptyDetail()}
				className={height}
			/>
		);
	// The table below the chart already shows a table-shaped result.
	if (display.type === "table") return null;
	if (!hydrated) return <Skeleton className={`${height} w-full`} />;
	const pointsOf = (series: SeriesResult) =>
		onGrid(
			series.points.flatMap((point) =>
				point.bucketMs === null
					? []
					: [
							{
								bucketMs: point.bucketMs,
								value: point.value,
								low: point.low,
								high: point.high,
							},
						],
			),
			grid,
		);
	const gapLabel = (series: SeriesResult, bucketMs: number) =>
		gapReason(result, series, bucketMs, step);
	const charting = view.visible.filter((series) => view.color(series));
	const bands = coverage.map(({ from, to, kind }) =>
		kind === "arriving"
			? {
					from,
					to,
					label: m.insight_data_still_arriving(),
					hatched: true,
					detail: arrivalDetail,
				}
			: { from, to, label: m.insight_no_data_received() },
	);
	const timeline: PanelProps["timeline"] = (series: ChartSeries[], heatmap) => (
		<TimeseriesChart
			label={m.insight_chart_label()}
			series={series}
			bucketSeconds={bucketSeconds}
			format={heatmap?.format ?? view.format(view.current[0])}
			axisFormat={view.chartFormat(view.current[0])}
			type={display.type as ChartType}
			logScale={display.logScale}
			beginAtZero={display.beginAtZero}
			goal={display.goal}
			domain={[
				grid[0] ?? result.from.getTime(),
				Math.max(
					result.to.getTime(),
					(grid.at(-1) ?? result.from.getTime()) + step,
				),
			]}
			bands={bands}
			height={height}
			className={height}
			onZoom={onZoom && ((from, to) => onZoom(new Date(from), new Date(to)))}
			// Off unless chosen: the results table and the tooltip already name the lines.
			legend={display.legend !== undefined}
			legendPosition={display.legend}
			showValues={display.showValues}
			xLabel={display.xLabel}
			yLabel={display.yLabel ?? heatmap?.quantity ?? view.subject ?? undefined}
			yMax={display.yMax}
			yMin={display.yMin}
			smooth={display.lineStyle === "smooth"}
			trend={display.trend}
			movingAverage={display.movingAverage}
			highlight={
				series.find((_, index) => lineId(charting[index]) === highlight)?.key ??
				null
			}
			gapLabel={(key, bucketMs) => {
				const series = charting[Number(key.slice(1))];
				return series ? gapLabel(series, bucketMs) : m.insight_gap_unknown();
			}}
			heatmap={heatmap}
		/>
	);
	return (
		<ChartPanel
			result={result}
			view={view}
			display={display}
			bucketSeconds={bucketSeconds}
			pointsOf={pointsOf}
			gapLabel={gapLabel}
			height={height}
			fill={fill}
			onGroup={onGroup}
			emptyDetail={emptyDetail()}
			timeline={timeline}
		/>
	);
}
