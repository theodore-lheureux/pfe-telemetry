import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { type ChartSeries, TimeseriesChart } from "../analytics/charts";
import { bucketGrid, onGrid } from "../analytics/insight/grid";
import { formatValue } from "../analytics/insight/labels";
import { IconEmptyState } from "../components/workspace";
import type { ExecutionLoad, LoadMetric, LoadShare } from "./overlaps";

const SHARE_LABEL: Record<LoadShare, () => string> = {
	execution: m.execution_overlap_share_execution,
	others: m.execution_overlap_share_others,
	unlabelled: m.execution_overlap_share_unlabelled,
};
const SHARE_COLOR: Record<LoadShare, string> = {
	execution: "var(--viz-1)",
	others: "var(--viz-2)",
	unlabelled: "var(--viz-3)",
};
const METRIC_LABEL: Record<LoadMetric, () => string> = {
	cpu: m.execution_overlap_cpu,
	memory: m.execution_overlap_memory,
};

/** One process metric on the execution's nodes, stacked by workload share. */
export function OverlapLoadChart({
	load,
	metric,
}: {
	load: ExecutionLoad;
	metric: LoadMetric;
}) {
	const entry = load.metrics[metric];
	const title = METRIC_LABEL[metric]();
	return (
		<figure className="flex min-w-0 flex-col gap-2">
			<figcaption className="text-sm font-medium">{title}</figcaption>
			<LoadBody load={load} title={title} entry={entry} />
		</figure>
	);
}

function LoadBody({
	load,
	title,
	entry,
}: {
	load: ExecutionLoad;
	title: string;
	entry: ExecutionLoad["metrics"][LoadMetric];
}) {
	if (!entry)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.execution_overlap_metric_missing()}
				heading="h4"
				className="h-56"
			/>
		);
	if (
		!entry.series.some((series) =>
			series.points.some((point) => point.value !== null),
		)
	)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.execution_overlap_load_empty()}
				heading="h4"
				className="h-56"
			/>
		);
	const grid = bucketGrid(load.from, load.to, load.bucketSeconds);
	const locale = getLocale();
	const series: ChartSeries[] = entry.series.map((share) => ({
		key: share.share,
		label: SHARE_LABEL[share.share](),
		color: SHARE_COLOR[share.share],
		points: onGrid(share.points, grid),
	}));
	return (
		<TimeseriesChart
			label={title}
			series={series}
			bucketSeconds={load.bucketSeconds}
			type="stacked"
			domain={[
				grid[0] ?? load.from.getTime(),
				grid.at(-1) ?? load.to.getTime(),
			]}
			format={(value) =>
				formatValue(
					value,
					{ unit: "auto" },
					{ unit: entry.unit, calculation: entry.calculation },
					locale,
				)
			}
			height="h-56"
			className="h-56"
		/>
	);
}
