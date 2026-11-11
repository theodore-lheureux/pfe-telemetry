import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

/** Whether the locale writes hours on a 12-hour clock, with its day-period names. */
function clock(locale: string) {
	const format = new Intl.DateTimeFormat(locale, { hour: "numeric" });
	if (!format.resolvedOptions().hour12) return null;
	const period = (hour: number) =>
		new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true })
			.formatToParts(new Date(2000, 0, 1, hour))
			.find((part) => part.type === "dayPeriod")?.value ?? "";
	return { am: period(0), pm: period(12) };
}

function TimeColumn({
	label,
	options,
	selected,
	onSelect,
}: {
	label: string;
	options: { value: number; text: string }[];
	selected: number;
	onSelect: (value: number) => void;
}) {
	const list = useRef<HTMLFieldSetElement>(null);
	// Keep the chosen value in view when the column appears or the bound changes.
	useEffect(() => {
		const container = list.current;
		const item = container?.querySelector<HTMLElement>(
			`[data-value="${selected}"]`,
		);
		if (container && item) container.scrollTop = item.offsetTop - 4;
	}, [selected]);
	return (
		<fieldset
			ref={list}
			className="flex h-full min-w-12 flex-col gap-0.5 overflow-y-auto border-l p-1 [scrollbar-width:none]"
		>
			<legend className="sr-only">{label}</legend>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === selected}
					data-value={option.value}
					onClick={() => onSelect(option.value)}
					className={cn(
						"shrink-0 rounded-md px-2 py-1.5 text-center text-sm tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
						option.value === selected &&
							"bg-primary text-primary-foreground hover:bg-primary",
					)}
				>
					{option.text}
				</button>
			))}
		</fieldset>
	);
}

/** Hour, minute and (on 12-hour clocks) AM/PM columns for a wall-clock time. */
export function TimeColumns({
	hours,
	minutes,
	onChange,
}: {
	hours: number;
	minutes: number;
	onChange: (hours: number, minutes: number) => void;
}) {
	const twelve = clock(getLocale());
	const two = (value: number) => String(value).padStart(2, "0");
	const hourOptions = (
		twelve
			? [12, ...Array.from({ length: 11 }, (_, index) => index + 1)]
			: Array.from({ length: 24 }, (_, value) => value)
	).map((value) => ({ value, text: two(value) }));
	const minuteOptions = Array.from({ length: 60 }, (_, value) => ({
		value,
		text: two(value),
	}));
	const pm = hours >= 12;
	return (
		<div className="flex h-full shrink-0">
			<TimeColumn
				label={m.range_hours()}
				options={hourOptions}
				selected={twelve ? hours % 12 || 12 : hours}
				onSelect={(value) =>
					onChange(twelve ? (value % 12) + (pm ? 12 : 0) : value, minutes)
				}
			/>
			<TimeColumn
				label={m.range_minutes()}
				options={minuteOptions}
				selected={minutes}
				onSelect={(value) => onChange(hours, value)}
			/>
			{twelve && (
				<TimeColumn
					label={m.range_period()}
					options={[
						{ value: 0, text: twelve.am },
						{ value: 1, text: twelve.pm },
					]}
					selected={pm ? 1 : 0}
					onSelect={(value) =>
						onChange((hours % 12) + (value ? 12 : 0), minutes)
					}
				/>
			)}
		</div>
	);
}
