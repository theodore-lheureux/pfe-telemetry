import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	CalculatorIcon,
	CalendarIcon,
	CircleUserIcon,
	FilterIcon,
	GitCompareArrowsIcon,
	InfoIcon,
	LineChartIcon,
	type LucideIcon,
	PencilIcon,
	RowsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { rangeLabel } from "../../components/date-range/date-range";
import { TimeDisplay, useDisplayTimeZone } from "../../components/time-display";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "../../components/ui/hover-card";
import { usePinnedOpen } from "../../components/use-pinned-open";
import type { DashboardFilters } from "../dashboard-filters";
import type { DashboardTile } from "../dashboards";
import { filterKey, filterText } from "../filter-chips";
import { groupFieldLabel } from "../group-by-picker";
import type { InsightDraft } from "../insight/draft";
import { COMPARISONS, comparisonKey } from "../insight/insight-toolbar";
import {
	CALCULATION_LABEL,
	COMBINE_OPTION_LABEL,
	DISPLAY_LABEL,
} from "../insight/labels";
import { metricLabel } from "../metric-names";
import { CreatorCell } from "../saved/saved-columns";

function Row({
	icon: Icon,
	label,
	children,
}: {
	icon: LucideIcon;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="grid grid-cols-[1rem_1fr] gap-x-2 gap-y-1">
			<Icon
				aria-hidden="true"
				className="mt-0.5 size-4 text-muted-foreground"
			/>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
				{children}
			</dd>
		</div>
	);
}

function FromDashboard() {
	return (
		<Badge variant="outline" className="border-primary/60 text-primary">
			{m.dashboard_info_dashboard()}
		</Badge>
	);
}

function None() {
	return (
		<span className="text-muted-foreground italic">
			{m.dashboard_info_none()}
		</span>
	);
}

function Person({
	person,
	at,
	userId,
}: {
	person: DashboardTile["insight"]["createdBy"];
	at: Date;
	userId: string;
}) {
	return (
		<>
			<CreatorCell person={person} userId={userId} />
			<TimeDisplay value={at} mode="relative" />
		</>
	);
}

/**
 * What a tile shows and where it comes from, on hover or focus of its info button:
 * its query, the range, filters and grouping in effect (marking the dashboard's
 * overrides), who made and changed the insight, and when the result was computed.
 */
export function TileInfo({
	tile,
	draft,
	filters,
	computedAt,
	userId,
}: {
	tile: DashboardTile;
	/** The draft as the dashboard runs it. */
	draft: InsightDraft;
	filters: DashboardFilters;
	computedAt: Date | null;
	userId: string;
}) {
	const pin = usePinnedOpen();
	const zone = useDisplayTimeZone();
	const locale = getLocale();
	const { insight } = tile;
	const added = new Set((filters.filters ?? []).map(filterKey));
	const range = rangeLabel(draft.range, locale, zone);
	const comparison = draft.compare
		? COMPARISONS.find((option) => option.key === comparisonKey(draft.compare))
		: undefined;
	return (
		<HoverCard {...pin.root} openDelay={200} closeDelay={100}>
			<HoverCardTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					className="text-muted-foreground [&_svg]:size-3.5"
					{...pin.trigger}
					aria-label={m.dashboard_tile_info({ name: insight.name })}
				>
					<InfoIcon aria-hidden="true" />
				</Button>
			</HoverCardTrigger>
			<HoverCardContent
				align="start"
				className="flex w-96 flex-col gap-3"
				{...pin.content}
			>
				<div className="flex flex-col gap-1">
					<p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{DISPLAY_LABEL[draft.display.type]()} • {range}
					</p>
					<p className="font-medium">{insight.name}</p>
					{insight.description && (
						<p className="text-sm text-muted-foreground">
							{insight.description}
						</p>
					)}
				</div>
				<dl className="flex flex-col gap-3">
					<Row icon={LineChartIcon} label={m.dashboard_info_query()}>
						<ul className="flex flex-col gap-1">
							{draft.series.map((series) => (
								<li key={series.name} className="flex items-center gap-2">
									<span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
										{series.name}
									</span>
									<span>
										{series.metric ? metricLabel(series.metric) : "—"}
										<span className="text-muted-foreground">
											{` · ${CALCULATION_LABEL[series.calculation]()} · ${COMBINE_OPTION_LABEL[series.combine]()}`}
										</span>
									</span>
								</li>
							))}
							{draft.formulas.map((formula) => (
								<li key={formula.expression} className="font-mono text-xs">
									{formula.name ? `${formula.name} = ` : ""}
									{formula.expression}
								</li>
							))}
						</ul>
					</Row>
					<Row icon={CalendarIcon} label={m.dashboard_info_range()}>
						{range}
						{filters.range && <FromDashboard />}
					</Row>
					<Row icon={FilterIcon} label={m.dashboard_info_filters()}>
						{draft.filters.length ? (
							draft.filters.map((filter) => (
								<Badge
									key={filterKey(filter)}
									variant="outline"
									className="font-normal"
								>
									{filterText(filter)}
									{added.has(filterKey(filter)) && (
										<span className="text-primary">
											{` · ${m.dashboard_info_dashboard()}`}
										</span>
									)}
								</Badge>
							))
						) : (
							<None />
						)}
					</Row>
					<Row icon={RowsIcon} label={m.dashboard_info_breakdown()}>
						{draft.groupBy ? groupFieldLabel(draft.groupBy) : <None />}
						{filters.breakdown !== undefined && <FromDashboard />}
					</Row>
					{(comparison || filters.compare !== undefined) && (
						<Row
							icon={GitCompareArrowsIcon}
							label={m.dashboard_info_comparison()}
						>
							{comparison ? comparison.label() : <None />}
							{filters.compare !== undefined && <FromDashboard />}
						</Row>
					)}
					<Row icon={CircleUserIcon} label={m.dashboard_info_created()}>
						<Person
							person={insight.createdBy}
							at={insight.createdAt}
							userId={userId}
						/>
					</Row>
					<Row icon={PencilIcon} label={m.dashboard_info_modified()}>
						<Person
							person={insight.updatedBy}
							at={insight.updatedAt}
							userId={userId}
						/>
					</Row>
					<Row icon={CalculatorIcon} label={m.dashboard_info_computed()}>
						{computedAt ? (
							<TimeDisplay value={computedAt} mode="relative" />
						) : (
							<span className="text-muted-foreground">
								{m.insight_updating()}
							</span>
						)}
					</Row>
				</dl>
			</HoverCardContent>
		</HoverCard>
	);
}
