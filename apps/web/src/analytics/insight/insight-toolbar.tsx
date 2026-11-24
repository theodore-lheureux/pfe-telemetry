import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { SlidersHorizontalIcon } from "lucide-react";
import { useId } from "react";
import { resolveRange } from "../../components/date-range/date-range";
import { DateRangePicker } from "../../components/date-range/date-range-picker";
import { useDisplayTimeZone } from "../../components/time-display";
import { Button } from "../../components/ui/button";
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
import { type Comparison, INTERVALS, type Interval } from "../contracts";
import { autoInterval, effectiveInterval, intervalFits } from "../intervals";
import { isHistogramPercentile } from "../validation";
import { DisplayOptions, spreadUnavailable } from "./display-options";
import {
	type DisplayType,
	type InsightDraft,
	MAX_RANGE_DAYS,
	withDisplay,
} from "./draft";
import {
	DISPLAY_ICON,
	DISPLAY_LABEL,
	INTERVAL_LABEL,
	PER_INTERVAL_LABEL,
} from "./labels";

export const COMPARISONS: {
	key: string;
	value?: Comparison;
	label: () => string;
}[] = [
	{ key: "none", label: m.insight_compare_none },
	{
		key: "previous",
		value: { previous: true },
		label: m.insight_compare_previous,
	},
	{
		key: "1d",
		value: { amount: 1, unit: "days" },
		label: m.insight_compare_day,
	},
	{
		key: "1w",
		value: { amount: 1, unit: "weeks" },
		label: m.insight_compare_week,
	},
	{
		key: "1mo",
		value: { amount: 1, unit: "months" },
		label: m.insight_compare_month,
	},
];

export function comparisonKey(comparison: Comparison | undefined) {
	return (
		COMPARISONS.find(
			(option) => JSON.stringify(option.value) === JSON.stringify(comparison),
		)?.key ?? "none"
	);
}

/** Time range, interval and comparison on the left; options and chart type on the right. */
export function InsightToolbar({
	draft,
	disabled,
	onChange,
}: {
	draft: InsightDraft;
	disabled: boolean;
	onChange: (draft: InsightDraft) => void;
}) {
	const _id = useId();
	const zone = useDisplayTimeZone();
	const now = new Date();
	const resolved = resolveRange(draft.range, now, zone, getLocale());
	const from = resolved.from,
		to = resolved.to ?? now;
	const interval = effectiveInterval(draft.interval, from, to);
	// A chosen interval too fine for the range runs, and shows, as automatic.
	const perLabel =
		interval === draft.interval
			? PER_INTERVAL_LABEL[interval]()
			: m.insight_per_auto({
					interval: PER_INTERVAL_LABEL[autoInterval(from, to)](),
				});
	const display = draft.display;
	const setDisplay = (next: Partial<InsightDraft["display"]>) =>
		onChange(withDisplay(draft, { ...display, ...next }));
	return (
		<div className="flex flex-wrap items-center gap-2">
			<DateRangePicker
				value={draft.range}
				disabled={disabled}
				maxDays={MAX_RANGE_DAYS}
				onChange={(range) => onChange({ ...draft, range })}
			/>
			{display.type !== "table" && (
				<div className="flex items-center gap-1.5">
					<span className="text-sm text-muted-foreground">
						{m.insight_interval_per()}
					</span>
					<Select
						value={interval === draft.interval ? draft.interval : "auto"}
						disabled={disabled}
						onValueChange={(interval) =>
							onChange({ ...draft, interval: interval as Interval | "auto" })
						}
					>
						<SelectTrigger aria-label={m.insight_interval()}>
							{/* Lowercase on the trigger, where it continues "per". */}
							<SelectValue>{perLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent position="popper" align="start">
							<SelectItem value="auto">
								{m.insight_interval_auto({
									interval: INTERVAL_LABEL[autoInterval(from, to)](),
								})}
							</SelectItem>
							{(Object.keys(INTERVALS) as Interval[])
								.filter((interval) => intervalFits(interval, from, to))
								.map((interval) => (
									<SelectItem key={interval} value={interval}>
										{INTERVAL_LABEL[interval]()}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
			)}
			{display.type !== "heatmap" && (
				<Select
					value={comparisonKey(draft.compare)}
					disabled={disabled}
					onValueChange={(key) => {
						const { compare: _, ...rest } = draft;
						const value = COMPARISONS.find(
							(option) => option.key === key,
						)?.value;
						onChange(value ? { ...draft, compare: value } : rest);
					}}
				>
					<SelectTrigger aria-label={m.insight_compare()}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						{COMPARISONS.map((option) => (
							<SelectItem key={option.key} value={option.key}>
								{option.label()}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<div className="ml-auto flex items-center gap-2">
				<Popover>
					<PopoverTrigger asChild>
						<Button
							variant="outline"
							size="icon"
							aria-label={m.insight_options()}
							title={m.insight_options()}
							disabled={disabled}
						>
							<SlidersHorizontalIcon aria-hidden="true" />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="w-auto">
						<DisplayOptions
							display={display}
							disabled={disabled}
							showType={false}
							spreadBlocked={spreadUnavailable(draft)}
							onChange={(next) => onChange({ ...draft, display: next })}
						/>
					</PopoverContent>
				</Popover>
				<Select
					value={display.type}
					disabled={disabled}
					onValueChange={(type) => setDisplay({ type: type as DisplayType })}
				>
					<SelectTrigger aria-label={m.insight_display()}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="end">
						{(Object.keys(DISPLAY_LABEL) as DisplayType[]).map((type) => {
							const Icon = DISPLAY_ICON[type];
							return (
								<SelectItem
									key={type}
									value={type}
									disabled={
										type === "heatmap" &&
										!draft.series.every(({ calculation }) =>
											isHistogramPercentile(calculation),
										)
									}
								>
									<Icon aria-hidden="true" />
									{DISPLAY_LABEL[type]()}
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}
