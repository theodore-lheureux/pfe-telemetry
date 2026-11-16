import { m } from "@recount/i18n/messages";
import { MoreHorizontalIcon } from "lucide-react";
import { useId, useState } from "react";
import {
	DEFAULT_RANGE,
	parseSerializedRange,
	serializeRange,
} from "../../components/date-range/date-range";
import { DateRangePicker } from "../../components/date-range/date-range-picker";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import type { ProjectReference } from "../../organizations/contracts";
import { AttributeFilter } from "../attribute-filter";
import { useQueryAttributes } from "../catalog";
import { INTERVALS, type Interval } from "../contracts";
import type { DashboardFilters } from "../dashboard-filters";
import { FilterChips, withFilter } from "../filter-chips";
import { GroupByPicker } from "../group-by-picker";
import { MAX_RANGE_DAYS } from "../insight/draft";
import { COMPARISONS, comparisonKey } from "../insight/insight-toolbar";
import { INTERVAL_LABEL, PER_INTERVAL_LABEL } from "../insight/labels";

// Radix Select cannot use an empty value, so "each insight's" and "none" have sentinels.
const EACH = "-each";
const NONE = "-none";

function without<K extends keyof DashboardFilters>(
	filters: DashboardFilters,
	key: K,
) {
	const { [key]: _, ...rest } = filters;
	return rest;
}

/**
 * Overrides for every tile: time range, interval, added filters, grouping and, under
 * advanced options, comparison. Each control's first choice keeps each insight's own.
 */
export function DashboardToolbar({
	userId,
	reference,
	filters,
	disabled,
	onChange,
	metrics,
}: {
	userId: string;
	reference: ProjectReference;
	filters: DashboardFilters;
	disabled: boolean;
	onChange: (filters: DashboardFilters) => void;
	metrics: string[];
}) {
	const id = useId();
	// Attributes load the first time a list that offers them opens.
	const [wantsAttributes, setWantsAttributes] = useState(false);
	const attributes = useQueryAttributes(
		userId,
		reference,
		metrics,
		wantsAttributes,
	);
	const range = filters.range && parseSerializedRange(filters.range);
	const set = <K extends keyof DashboardFilters>(
		key: K,
		value: DashboardFilters[K] | undefined,
	) =>
		onChange(
			value === undefined
				? without(filters, key)
				: { ...filters, [key]: value },
		);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<DateRangePicker
				value={range || DEFAULT_RANGE}
				none={{
					label: m.dashboard_no_range_override(),
					selected: !range,
					onClear: () => set("range", undefined),
				}}
				disabled={disabled}
				maxDays={MAX_RANGE_DAYS}
				onChange={(next) => set("range", serializeRange(next))}
			/>
			<div className="flex items-center gap-1.5">
				<span className="text-sm text-muted-foreground">
					{m.insight_interval_per()}
				</span>
				<Select
					value={filters.interval ?? EACH}
					disabled={disabled}
					onValueChange={(value) =>
						set("interval", value === EACH ? undefined : (value as Interval))
					}
				>
					<SelectTrigger aria-label={m.insight_interval()}>
						{/* Lowercase on the trigger, where it continues "per". */}
						<SelectValue>
							{filters.interval
								? PER_INTERVAL_LABEL[filters.interval]()
								: m.dashboard_each_interval()}
						</SelectValue>
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						<SelectItem value={EACH}>
							{m.dashboard_each_interval_option()}
						</SelectItem>
						{(Object.keys(INTERVALS) as Interval[]).map((interval) => (
							<SelectItem key={interval} value={interval}>
								{INTERVAL_LABEL[interval]()}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<FilterChips
				filters={filters.filters ?? []}
				disabled={disabled}
				onChange={(next) => set("filters", next.length ? next : undefined)}
			/>
			<AttributeFilter
				attributes={attributes.data}
				loading={attributes.isFetching}
				values={{ userId, reference }}
				disabled={disabled}
				label={m.dashboard_add_filter()}
				onOpen={() => setWantsAttributes(true)}
				onAdd={(filter) =>
					set("filters", withFilter(filters.filters ?? [], filter))
				}
			/>
			<GroupByPicker
				value={filters.breakdown === "" ? NONE : (filters.breakdown ?? EACH)}
				choices={[
					{ value: EACH, label: m.dashboard_each_breakdown() },
					{ value: NONE, label: m.dashboard_no_breakdown() },
				]}
				attributes={attributes.data}
				loading={attributes.isFetching}
				disabled={disabled}
				onOpen={() => setWantsAttributes(true)}
				onChange={(value) => {
					if (value === EACH) return set("breakdown", undefined);
					set("breakdown", value === NONE ? "" : value);
				}}
			/>
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						disabled={disabled}
						aria-label={m.dashboard_advanced()}
						title={m.dashboard_advanced()}
					>
						<MoreHorizontalIcon aria-hidden="true" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="flex w-80 flex-col gap-3">
					<div className="flex flex-col gap-0.5">
						<p className="text-sm font-medium">{m.dashboard_advanced()}</p>
						<p className="text-xs text-muted-foreground">
							{m.dashboard_advanced_description()}
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-compare`}>{m.dashboard_comparison()}</Label>
						<Select
							value={
								filters.compare === undefined
									? EACH
									: comparisonKey(filters.compare ?? undefined)
							}
							onValueChange={(key) => {
								if (key === EACH) return set("compare", undefined);
								const option = COMPARISONS.find((entry) => entry.key === key);
								set("compare", option?.value ?? null);
							}}
						>
							<SelectTrigger id={`${id}-compare`} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" align="start">
								<SelectItem value={EACH}>
									{m.dashboard_each_comparison()}
								</SelectItem>
								{COMPARISONS.map((option) => (
									<SelectItem key={option.key} value={option.key}>
										{option.label()}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
