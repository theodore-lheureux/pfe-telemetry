import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { LayoutDashboardIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	type DateRange,
	DEFAULT_RANGE,
	resolveRange,
} from "../../components/date-range/date-range";
import { DateRangePicker } from "../../components/date-range/date-range-picker";
import { useDisplayTimeZone } from "../../components/time-display";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { IconEmptyState } from "../../components/workspace";
import { operationMessage } from "../../lib/operation-message";
import type { MutationFailure } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { MAX_RANGE_DAYS } from "../insight/draft";
import { InsightsHeader } from "../insights-header";
import type { OverviewStat } from "../overview.server";
import { ComputedAt, RefreshButton } from "../refresh-status";
import { NodesTable } from "./nodes-table";
import { OverviewChart } from "./overview-chart";
import { DEFAULT_OVERVIEW_RANGE } from "./overview-query";
import { StatTiles } from "./stat-tiles";
import { useOverview } from "./use-overview";

type Failure = MutationFailure["failure"];

/**
 * The fleet at a glance: headline statistics compared with the previous period, the
 * chosen one charted, and each node's latest usage. Each part fills in as its data
 * arrives.
 */
export function FleetOverview({
	userId,
	reference,
}: {
	userId: string;
	reference: ProjectReference;
}) {
	const hydrated = useHydrated();
	const locale = getLocale();
	const zone = useDisplayTimeZone();
	const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
	// Relative ranges resolve when chosen or refreshed, not on every render.
	const [now, setNow] = useState(() => new Date());
	const [changed, setChanged] = useState(false);
	const [stat, setStat] = useState<OverviewStat>("cpu");
	const resolved = resolveRange(range, now, zone, locale);
	const from = resolved.from.toISOString(),
		to = (resolved.to ?? now).toISOString();
	// Until the range changes or a refresh, read the queries the route's loader started.
	const overview = useOverview(
		userId,
		reference,
		changed ? { from, to } : DEFAULT_OVERVIEW_RANGE,
	);
	const refresh = () => {
		setChanged(true);
		setNow(new Date());
	};
	const selected =
		overview.tiles.find((tile) => tile.stat === stat) ?? overview.tiles[0];
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="overview" reference={reference} />
			<div className="flex flex-wrap items-center justify-between gap-3">
				<DateRangePicker
					value={range}
					disabled={!hydrated}
					maxDays={MAX_RANGE_DAYS}
					onChange={(next) => {
						setRange(next);
						refresh();
					}}
				/>
				<div className="flex items-center gap-2">
					<ComputedAt
						computedAt={overview.computedAt}
						fetching={overview.fetching}
					/>
					<RefreshButton
						fetching={overview.fetching}
						disabled={!hydrated}
						onRefresh={refresh}
					/>
				</div>
			</div>
			<OverviewState
				failure={overview.failed ? overview.failure : null}
				empty={overview.empty}
				onRetry={refresh}
			>
				<div aria-busy={overview.fetching} className="flex flex-col gap-5">
					{overview.failure && (
						<PartialFailure failure={overview.failure} onRetry={refresh} />
					)}
					<StatTiles
						tiles={overview.tiles}
						selected={selected?.stat}
						hydrated={hydrated}
						locale={locale}
						onSelect={setStat}
					/>
					{selected && (
						<OverviewChart
							tile={selected}
							hydrated={hydrated}
							locale={locale}
						/>
					)}
					<NodesTable
						nodes={overview.nodes}
						pending={overview.pendingSections}
						loading={overview.fetching}
						locale={locale}
					/>
				</div>
			</OverviewState>
		</section>
	);
}

/** Some sections failed while others loaded. */
function PartialFailure({
	failure,
	onRetry,
}: {
	failure: Failure;
	onRetry: () => void;
}) {
	return (
		<Alert variant="destructive">
			<TriangleAlertIcon aria-hidden="true" />
			<AlertTitle>{m.overview_partial_failure()}</AlertTitle>
			<AlertDescription>{operationMessage(failure)}</AlertDescription>
			<AlertAction>
				<Button variant="outline" size="sm" onClick={onRetry}>
					{m.try_again()}
				</Button>
			</AlertAction>
		</Alert>
	);
}

/**
 * Shown instead of the overview when every section failed, with the reason and a
 * retry, or when the project has not sent node metrics yet.
 */
function OverviewState({
	failure,
	empty,
	onRetry,
	children,
}: {
	failure: Failure | null;
	empty: boolean;
	onRetry: () => void;
	children: ReactNode;
}) {
	if (failure)
		return (
			<IconEmptyState
				icon={<TriangleAlertIcon aria-hidden="true" />}
				title={m.overview_unavailable()}
				description={operationMessage(failure)}
				alert
				className="bg-card"
			>
				<Button variant="outline" onClick={onRetry}>
					{m.try_again()}
				</Button>
			</IconEmptyState>
		);
	if (empty)
		return (
			<IconEmptyState
				icon={<LayoutDashboardIcon aria-hidden="true" />}
				title={m.overview_empty()}
				description={m.overview_empty_description()}
				className="bg-card"
			/>
		);
	return children;
}
