import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { SlidersHorizontalIcon } from "lucide-react";
import { useId } from "react";
import { resolveRange } from "../../components/date-range/date-range";
import { DateRangePicker } from "../../components/date-range/date-range-picker";
import { useDisplayTimeZone } from "../../components/time-display";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
import { Switch } from "../../components/ui/switch";
import { type Comparison, INTERVALS, type Interval } from "../contracts";
import { autoInterval, effectiveInterval, intervalFits } from "../intervals";
import {
	type DisplayType,
	type DisplayUnit,
	type InsightDraft,
	MAX_RANGE_DAYS,
} from "./draft";
import {
	DISPLAY_ICON,
	DISPLAY_LABEL,
	INTERVAL_LABEL,
	UNIT_LABEL,
} from "./labels";

const COMPARISONS: { key: string; value?: Comparison; label: () => string }[] =
	[
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

function comparisonKey(comparison: Comparison | undefined) {
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
	const id = useId();
	const zone = useDisplayTimeZone();
	const now = new Date();
	const resolved = resolveRange(draft.range, now, zone, getLocale());
	const from = resolved.from,
		to = resolved.to ?? now;
	const display = draft.display;
	const setDisplay = (next: Partial<InsightDraft["display"]>) =>
		onChange({ ...draft, display: { ...display, ...next } });
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
						{m.insight_grouped_by()}
					</span>
					<Select
						// A chosen interval too fine for the range runs, and shows, as automatic.
						value={
							effectiveInterval(draft.interval, from, to) === draft.interval
								? draft.interval
								: "auto"
						}
						disabled={disabled}
						onValueChange={(interval) =>
							onChange({ ...draft, interval: interval as Interval | "auto" })
						}
					>
						<SelectTrigger aria-label={m.insight_interval()}>
							<SelectValue />
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
			<Select
				value={comparisonKey(draft.compare)}
				disabled={disabled}
				onValueChange={(key) => {
					const { compare: _, ...rest } = draft;
					const value = COMPARISONS.find((option) => option.key === key)?.value;
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
					<PopoverContent align="end" className="flex w-72 flex-col gap-3">
						<p className="text-sm font-medium">{m.insight_options()}</p>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-unit`}>{m.insight_unit()}</Label>
							<Select
								value={display.unit}
								onValueChange={(unit) =>
									setDisplay({ unit: unit as DisplayUnit })
								}
							>
								<SelectTrigger id={`${id}-unit`} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper" align="start">
									{(Object.keys(UNIT_LABEL) as DisplayUnit[]).map((unit) => (
										<SelectItem key={unit} value={unit}>
											{UNIT_LABEL[unit]()}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={`${id}-goal`}>{m.insight_goal()}</Label>
							<Input
								id={`${id}-goal`}
								type="number"
								value={display.goal ?? ""}
								placeholder={m.insight_goal_none()}
								onChange={(event) => {
									const value = event.target.value;
									const { goal: _, ...rest } = display;
									onChange({
										...draft,
										display:
											value === "" || !Number.isFinite(Number(value))
												? rest
												: { ...display, goal: Number(value) },
									});
								}}
							/>
						</div>
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor={`${id}-log`}>{m.insight_log_scale()}</Label>
							<Switch
								id={`${id}-log`}
								checked={display.logScale}
								onCheckedChange={(logScale) => setDisplay({ logScale })}
							/>
						</div>
						<div className="flex items-center justify-between gap-2">
							<Label htmlFor={`${id}-zero`}>{m.insight_begin_at_zero()}</Label>
							<Switch
								id={`${id}-zero`}
								checked={display.beginAtZero}
								disabled={display.logScale}
								onCheckedChange={(beginAtZero) => setDisplay({ beginAtZero })}
							/>
						</div>
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
								<SelectItem key={type} value={type}>
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
