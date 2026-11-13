import { m } from "@recount/i18n/messages";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { OverviewMetric, OverviewStat } from "../overview.server";
import { StatCard } from "../stat-card";
import { formatStat, RATIOS, STAT_LABEL } from "./format";
import type { OverviewTile } from "./use-overview";

/** The change from the previous period: points for ratios, percent for counts. */
function changeOf(metric: OverviewMetric) {
	if (metric.current === null || metric.previous === null) return null;
	if (RATIOS.has(metric.stat)) return (metric.current - metric.previous) * 100;
	if (!metric.previous) return null;
	return (metric.current - metric.previous) / metric.previous;
}

/** The change as a neutral badge; neither direction is good or bad. */
function Delta({ metric, locale }: { metric: OverviewMetric; locale: string }) {
	const change = changeOf(metric);
	if (change === null || !Number.isFinite(change)) return null;
	const text = RATIOS.has(metric.stat)
		? m.overview_points({
				value: new Intl.NumberFormat(locale, {
					maximumFractionDigits: 1,
					signDisplay: "exceptZero",
				}).format(change),
			})
		: new Intl.NumberFormat(locale, {
				style: "percent",
				maximumFractionDigits: 1,
				signDisplay: "exceptZero",
			}).format(change);
	const Icon = change >= 0 ? ArrowUpIcon : ArrowDownIcon;
	return (
		<span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
			<Icon aria-hidden="true" className="size-3" />
			{text}
		</span>
	);
}

function detailOf(metric: OverviewMetric | null, locale: string) {
	if (metric?.previous == null) return m.overview_no_prior();
	return m.overview_vs_prior({
		value: formatStat(metric.stat, metric.previous, locale),
	});
}

/**
 * One card per fleet statistic, each filling in when its data arrives; choosing a card
 * shows it in the chart below.
 */
export function StatTiles({
	tiles,
	selected,
	hydrated,
	locale,
	onSelect,
}: {
	tiles: OverviewTile[];
	selected: OverviewStat | undefined;
	hydrated: boolean;
	locale: string;
	onSelect: (stat: OverviewStat) => void;
}) {
	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			{tiles.map((tile) => (
				<StatCard
					key={tile.stat}
					title={STAT_LABEL[tile.stat]()}
					value={formatStat(tile.stat, tile.metric?.current ?? null, locale)}
					aside={tile.metric && <Delta metric={tile.metric} locale={locale} />}
					detail={detailOf(tile.metric, locale)}
					points={tile.metric?.series ?? []}
					bucketSeconds={tile.bucketSeconds ?? 60}
					hydrated={hydrated}
					loading={tile.fetching}
					pending={tile.pending}
					selected={tile.stat === selected}
					selectLabel={m.overview_select_stat({
						stat: STAT_LABEL[tile.stat](),
					})}
					onSelect={() => onSelect(tile.stat)}
				/>
			))}
		</div>
	);
}
