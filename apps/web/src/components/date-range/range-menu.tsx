import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/ui/button";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "../components/ui/command";
import { Label } from "../components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "../components/ui/native-select";
import { Separator } from "../components/ui/separator";
import {
	CALENDAR_PRESETS,
	type CalendarPreset,
	type DateRange,
	LAST_PRESETS,
	lastLabel,
	presetLabel,
	RANGE_UNITS,
	type RangeUnit,
} from "./date-range";

export type CustomView = "since" | "between" | "jump";

const UNIT_LABEL: Record<RangeUnit, () => string> = {
	minutes: m.range_unit_minutes,
	hours: m.range_unit_hours,
	days: m.range_unit_days,
	weeks: m.range_unit_weeks,
	months: m.range_unit_months,
	years: m.range_unit_years,
};
// Menu order: days first, then the relative choices, then calendar periods.
const PRESETS: DateRange[] = [
	{ kind: "preset", preset: "today" },
	{ kind: "preset", preset: "yesterday" },
	...LAST_PRESETS.map((last) => ({ kind: "last" as const, ...last })),
	...CALENDAR_PRESETS.filter(
		(preset) => preset !== "today" && preset !== "yesterday",
	).map((preset: CalendarPreset) => ({ kind: "preset" as const, preset })),
];
const CUSTOM: { view: CustomView; label: () => string }[] = [
	{ view: "since", label: m.range_custom_since },
	{ view: "between", label: m.range_custom_between },
];

function presetKey(range: DateRange) {
	if (range.kind === "last") return `last:${range.count}:${range.unit}`;
	return range.kind === "preset" ? `preset:${range.preset}` : range.kind;
}

function presetText(range: DateRange, locale: string) {
	if (range.kind === "last") return lastLabel(range.count, range.unit, locale);
	return range.kind === "preset" ? presetLabel(range.preset) : "";
}

/** "In the last N units", applied as it changes. */
function LastRange({
	value,
	onChange,
}: {
	value: DateRange;
	onChange: (value: DateRange) => void;
}) {
	const id = useId();
	const [count, setCount] = useState(value.kind === "last" ? value.count : 1),
		[unit, setUnit] = useState<RangeUnit>(
			value.kind === "last" ? value.unit : "hours",
		);
	const set = (nextCount: number, nextUnit: RangeUnit) => {
		const bounded = Math.min(Math.max(Math.round(nextCount) || 1, 1), 999);
		setCount(bounded);
		setUnit(nextUnit);
		onChange({ kind: "last", count: bounded, unit: nextUnit });
	};
	return (
		<div className="flex items-center gap-2 px-3 py-1.5 text-sm">
			<span className="shrink-0">{m.range_in_the_last()}</span>
			<div className="flex h-8 items-center rounded-md border">
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={m.range_decrease()}
					onClick={() => set(count - 1, unit)}
					disabled={count <= 1}
				>
					<MinusIcon aria-hidden="true" />
				</Button>
				<Label htmlFor={`${id}-count`} className="sr-only">
					{m.range_count()}
				</Label>
				<input
					id={`${id}-count`}
					type="number"
					inputMode="numeric"
					min={1}
					max={999}
					value={count}
					onChange={(event) => set(Number(event.target.value), unit)}
					className="w-10 [appearance:textfield] bg-transparent text-center tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none"
				/>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={m.range_increase()}
					onClick={() => set(count + 1, unit)}
					disabled={count >= 999}
				>
					<PlusIcon aria-hidden="true" />
				</Button>
			</div>
			<Label htmlFor={`${id}-unit`} className="sr-only">
				{m.range_unit()}
			</Label>
			<NativeSelect
				id={`${id}-unit`}
				value={unit}
				onChange={(event) => set(count, event.target.value as RangeUnit)}
				className="min-w-0 flex-1"
			>
				{RANGE_UNITS.map((option) => (
					<NativeSelectOption key={option} value={option}>
						{UNIT_LABEL[option]()}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}

/** Preset ranges, "in the last N units", and entries that open the custom panels. */
export function RangeMenu({
	value,
	onChoose,
	onChange,
	onCustom,
}: {
	value: DateRange;
	/** Applies a preset and closes the picker. */
	onChoose: (value: DateRange) => void;
	/** Applies a range and keeps the picker open. */
	onChange: (value: DateRange) => void;
	onCustom: (view: CustomView) => void;
}) {
	const locale = getLocale();
	const selected = presetKey(value);
	return (
		<Command>
			{/* One list, so arrow keys move through presets and custom entries alike. */}
			<CommandList className="max-h-[min(36rem,var(--radix-popover-content-available-height))]">
				<CommandGroup>
					{PRESETS.map((range) => (
						<CommandItem
							key={presetKey(range)}
							value={presetKey(range)}
							data-checked={presetKey(range) === selected}
							onSelect={() => onChoose(range)}
						>
							{presetText(range, locale)}
						</CommandItem>
					))}
				</CommandGroup>
				<LastRange value={value} onChange={onChange} />
				<Separator />
				<CommandGroup>
					{CUSTOM.map((item) => (
						<CommandItem
							key={item.view}
							value={item.view}
							data-checked={value.kind === item.view}
							onSelect={() => onCustom(item.view)}
						>
							{item.label()}
						</CommandItem>
					))}
				</CommandGroup>
				<Separator />
				<CommandGroup>
					<CommandItem
						value="jump"
						data-checked={value.kind === "jump"}
						onSelect={() => onCustom("jump")}
					>
						{m.range_jump()}
					</CommandItem>
				</CommandGroup>
			</CommandList>
		</Command>
	);
}
