import { m } from "@recount/i18n/messages";
import { LoadingBar } from "../../components/loading-bar";
import { Skeleton } from "../../components/ui/skeleton";
import { TimeseriesChart } from "../charts";
import { formatStat, STAT_DESCRIPTION, STAT_LABEL } from "./format";
import type { OverviewTile } from "./use-overview";

/** The chosen statistic over the range, against the previous period. */
export function OverviewChart({
	tile: { stat, metric, bucketSeconds, fetching },
	hydrated,
	locale,
}: {
	tile: OverviewTile;
	hydrated: boolean;
	locale: string;
}) {
	const label = STAT_LABEL[stat]();
	return (
		<div className="relative flex flex-col gap-4 overflow-hidden rounded-lg border bg-card p-4">
			<LoadingBar active={fetching} />
			<div className="flex flex-col gap-1">
				<h2 className="text-base font-semibold">{label}</h2>
				<p className="text-sm text-muted-foreground">
					{STAT_DESCRIPTION[stat]()}
				</p>
			</div>
			{hydrated && metric && bucketSeconds ? (
				<TimeseriesChart
					label={m.overview_chart({ stat: label })}
					bucketSeconds={bucketSeconds}
					format={(value) => formatStat(stat, value, locale)}
					series={[
						{
							key: "current",
							label: m.overview_this_period(),
							color: "var(--viz-1)",
							points: metric.series,
						},
						{
							key: "previous",
							label: m.overview_previous_period(),
							color: "var(--viz-1)",
							points: metric.previousSeries,
							comparison: true,
						},
					]}
				/>
			) : (
				<Skeleton className="h-72 w-full" />
			)}
		</div>
	);
}
