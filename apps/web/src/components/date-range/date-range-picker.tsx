import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useDisplayTimeZone } from "../time-display";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { type DateRange, rangeLabel, wallTime } from "./date-range";
import { DateTimePanel } from "./date-time-panel";
import { JumpPanel } from "./jump-panel";
import { type CustomView, RangeMenu } from "./range-menu";

type View = "menu" | CustomView;

// Custom date panels size themselves: two months for a day range, one month with time.
const PANEL_WIDTH: Partial<Record<View, string>> = {
	menu: "w-72",
	jump: "w-96",
};

/** A PostHog-style time range: presets, "in the last N units", custom ranges and jumps. */
export function DateRangePicker({
	value,
	disabled,
	maxDays,
	onChange,
}: {
	value: DateRange;
	disabled: boolean;
	/** Hides presets longer than this; custom ranges are checked by the server. */
	maxDays?: number;
	onChange: (value: DateRange) => void;
}) {
	const locale = getLocale(),
		zone = useDisplayTimeZone();
	const [open, setOpen] = useState(false),
		[view, setView] = useState<View>("menu");
	const choose = (next: DateRange) => {
		onChange(next);
		setOpen(false);
	};
	// Custom ranges open on the current selection, or on the hour before now.
	const panelInitial = () => {
		const minute = Math.floor(Date.now() / 60_000) * 60_000;
		const from =
			value.kind === "since" || value.kind === "between"
				? value.from
				: new Date(minute - 3_600_000);
		const to = value.kind === "between" ? value.to : new Date(minute);
		const midnight = (date: Date) => wallTime(date, zone) === "00:00";
		return {
			from,
			to,
			withTime:
				(value.kind === "since" || value.kind === "between") &&
				!(midnight(from) && (value.kind === "since" || midnight(to))),
		};
	};
	const label = rangeLabel(value, locale, zone);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) setView("menu");
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					disabled={disabled}
					aria-label={`${m.insight_range()}: ${label}`}
					className="max-w-80"
				>
					<CalendarIcon aria-hidden="true" />
					<span className="truncate">{label}</span>
					<ChevronDownIcon aria-hidden="true" className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn(
					"max-w-[calc(100vw-2rem)] gap-0 p-0",
					PANEL_WIDTH[view] ?? "w-auto",
				)}
			>
				{view === "menu" && (
					<RangeMenu
						value={value}
						maxDays={maxDays}
						onChoose={choose}
						onChange={onChange}
						onCustom={setView}
					/>
				)}
				{(view === "since" || view === "between") && (
					<DateTimePanel
						kind={view}
						zone={zone}
						initial={panelInitial()}
						onApply={(range) =>
							choose(
								view === "between" && range.to
									? { kind: "between", from: range.from, to: range.to }
									: { kind: "since", from: range.from },
							)
						}
						onCancel={() => setView("menu")}
						onClose={() => setOpen(false)}
					/>
				)}
				{view === "jump" && (
					<JumpPanel
						value={value}
						onApply={choose}
						onCancel={() => setView("menu")}
						onClose={() => setOpen(false)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}
