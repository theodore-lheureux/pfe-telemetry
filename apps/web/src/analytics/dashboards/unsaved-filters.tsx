import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import {
	ArrowRightIcon,
	CalendarIcon,
	ClockIcon,
	FilterIcon,
	GitCompareArrowsIcon,
	InfoIcon,
	type LucideIcon,
	RowsIcon,
} from "lucide-react";
import {
	parseSerializedRange,
	rangeLabel,
} from "../../components/date-range/date-range";
import { useDisplayTimeZone } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import { ButtonGroup, ButtonGroupText } from "../../components/ui/button-group";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "../../components/ui/hover-card";
import { usePinnedOpen } from "../../components/use-pinned-open";
import type { DashboardFilters } from "../dashboard-filters";
import { filterKey, filterText } from "../filter-chips";
import { groupFieldLabel } from "../group-by-picker";
import { COMPARISONS, comparisonKey } from "../insight/insight-toolbar";
import { INTERVAL_LABEL } from "../insight/labels";

const WARNING = "border-amber-400/70 bg-amber-50 dark:bg-amber-950/40";

interface Change {
	key: string;
	icon: LucideIcon;
	label: string;
	from: string;
	to: string;
}

type Setting = Omit<Change, "from" | "to"> & {
	text: (filters: DashboardFilters) => string;
	differs: boolean;
};

function rangeText(filters: DashboardFilters, locale: string, zone: string) {
	const range = filters.range && parseSerializedRange(filters.range);
	return range
		? rangeLabel(range, locale, zone)
		: m.dashboard_no_range_override();
}

function groupText(filters: DashboardFilters) {
	if (filters.breakdown === undefined) return m.dashboard_each_breakdown();
	return filters.breakdown
		? groupFieldLabel(filters.breakdown)
		: m.dashboard_no_breakdown();
}

function compareText(filters: DashboardFilters) {
	if (filters.compare === undefined) return m.dashboard_each_comparison();
	const key = comparisonKey(filters.compare ?? undefined);
	return COMPARISONS.find((option) => option.key === key)?.label() ?? key;
}

/** Each setting that differs from the saved overrides, as saved → current. */
function settingChanges(
	current: DashboardFilters,
	saved: DashboardFilters,
	locale: string,
	zone: string,
): Change[] {
	const settings: Setting[] = [
		{
			key: "range",
			icon: CalendarIcon,
			label: m.dashboard_info_range(),
			text: (filters) => rangeText(filters, locale, zone),
			differs: JSON.stringify(current.range) !== JSON.stringify(saved.range),
		},
		{
			key: "interval",
			icon: ClockIcon,
			label: m.insight_interval(),
			text: (filters) =>
				filters.interval
					? INTERVAL_LABEL[filters.interval]()
					: m.dashboard_each_interval_option(),
			differs: current.interval !== saved.interval,
		},
		{
			key: "breakdown",
			icon: RowsIcon,
			label: m.dashboard_info_breakdown(),
			text: groupText,
			differs: current.breakdown !== saved.breakdown,
		},
		{
			key: "compare",
			icon: GitCompareArrowsIcon,
			label: m.dashboard_comparison(),
			text: compareText,
			differs:
				JSON.stringify(current.compare) !== JSON.stringify(saved.compare),
		},
	];
	return settings
		.filter((setting) => setting.differs)
		.map(({ text, differs: _, ...setting }) => ({
			...setting,
			from: text(saved),
			to: text(current),
		}));
}

/** Filters in `a` that `b` lacks. */
function missing(a: DashboardFilters, b: DashboardFilters) {
	const keys = new Set((b.filters ?? []).map(filterKey));
	return (a.filters ?? []).filter((filter) => !keys.has(filterKey(filter)));
}

function Row({
	icon: Icon,
	label,
	children,
}: {
	icon: LucideIcon;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-[1rem_1fr] gap-x-2 gap-y-1">
			<Icon
				aria-hidden="true"
				className="mt-0.5 size-4 text-muted-foreground"
			/>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="col-start-2 flex min-w-0 flex-col gap-0.5 text-sm">
				{children}
			</dd>
		</div>
	);
}

/**
 * How many overrides are unsaved, what they are on hover or click of its info button,
 * and buttons to discard or save them.
 */
export function UnsavedFilters({
	count,
	current,
	saved,
	canSave,
	disabled,
	saving,
	onDiscard,
	onSave,
}: {
	count: number;
	current: DashboardFilters;
	saved: DashboardFilters;
	canSave: boolean;
	disabled: boolean;
	saving: boolean;
	onDiscard: () => void;
	onSave: () => void;
}) {
	const pin = usePinnedOpen();
	const zone = useDisplayTimeZone();
	const changes = settingChanges(current, saved, getLocale(), zone);
	const added = missing(current, saved),
		removed = missing(saved, current);
	const hint = canSave
		? m.dashboard_unsaved_hint()
		: m.dashboard_unsaved_hint_viewer();
	return (
		<ButtonGroup aria-label={m.dashboard_unsaved_filters({ count })}>
			<ButtonGroupText className={WARNING}>
				<span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />
				{m.dashboard_unsaved_filters({ count })}
				<HoverCard {...pin.root} openDelay={150} closeDelay={100}>
					<HoverCardTrigger asChild>
						<button
							type="button"
							aria-label={m.dashboard_unsaved_changes()}
							className="rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							{...pin.trigger}
						>
							<InfoIcon aria-hidden="true" className="size-4" />
						</button>
					</HoverCardTrigger>
					<HoverCardContent
						align="start"
						className="flex w-80 flex-col gap-3"
						{...pin.content}
					>
						<p className="font-medium">{m.dashboard_unsaved_changes()}</p>
						<dl className="flex flex-col gap-3">
							{changes.map((change) => (
								<Row key={change.key} icon={change.icon} label={change.label}>
									<span className="flex flex-wrap items-center gap-1.5">
										<span className="text-muted-foreground">{change.from}</span>
										<ArrowRightIcon aria-hidden="true" className="size-3.5" />
										<span className="font-medium">{change.to}</span>
									</span>
								</Row>
							))}
							{(added.length > 0 || removed.length > 0) && (
								<Row icon={FilterIcon} label={m.dashboard_info_filters()}>
									{added.map((filter) => (
										<span key={`+${filterKey(filter)}`}>
											<span className="text-muted-foreground">
												{m.dashboard_filter_added()}:{" "}
											</span>
											<span className="font-medium">{filterText(filter)}</span>
										</span>
									))}
									{removed.map((filter) => (
										<span key={`-${filterKey(filter)}`}>
											<span className="text-muted-foreground">
												{m.dashboard_filter_removed()}:{" "}
											</span>
											<span className="line-through">{filterText(filter)}</span>
										</span>
									))}
								</Row>
							)}
						</dl>
						<p className="text-xs text-muted-foreground">{hint}</p>
					</HoverCardContent>
				</HoverCard>
			</ButtonGroupText>
			<Button
				variant="outline"
				className={WARNING}
				disabled={disabled}
				onClick={onDiscard}
			>
				{m.dashboard_discard_filters()}
			</Button>
			{canSave && (
				<Button
					variant="outline"
					className={WARNING}
					disabled={disabled || saving}
					onClick={onSave}
				>
					{m.dashboard_save_filters()}
				</Button>
			)}
		</ButtonGroup>
	);
}
