import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { type FormEvent, useId, useState } from "react";
import { enUS, fr } from "react-day-picker/locale";
import { Calendar } from "../components/ui/calendar";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { atTime, dayStart, nextDayStart, wallTime } from "./date-range";
import { PanelFooter, PanelHeader } from "./picker-panel";
import { TimeColumns } from "./time-columns";

type Bound = "start" | "end";

/**
 * A calendar with optional hour and minute columns, for a start date ("since") or a
 * start and end ("between"). Its width stays fixed whether or not time is included.
 */
export function DateTimePanel({
	kind,
	zone,
	initial,
	onApply,
	onCancel,
	onClose,
}: {
	kind: "since" | "between";
	zone: string;
	initial: { from: Date; to: Date; withTime: boolean };
	onApply: (range: { from: Date; to?: Date }) => void;
	onCancel: () => void;
	onClose: () => void;
}) {
	const id = useId();
	const locale = getLocale();
	const [start, setStart] = useState(initial.from),
		[end, setEnd] = useState(initial.to),
		[active, setActive] = useState<Bound>("start"),
		[withTime, setWithTime] = useState(initial.withTime);
	const now = new Date();
	const current = active === "start" || kind === "since" ? start : end;
	const update = (next: Date) => {
		if (active === "start" || kind === "since") setStart(next);
		else setEnd(next);
	};
	const [hours = 0, minutes = 0] = wallTime(current, zone)
		.split(":")
		.map(Number);
	const setWall = (nextHours: number, nextMinutes: number) =>
		update(
			atTime(
				current,
				`${String(nextHours).padStart(2, "0")}:${String(nextMinutes).padStart(2, "0")}`,
				zone,
			),
		);
	const bounds = () => {
		const from = withTime ? start : dayStart(start, zone);
		if (kind === "since") return { from };
		// A day-only end includes that whole day.
		const to = withTime ? end : nextDayStart(end, zone);
		return { from, to };
	};
	const resolved = bounds();
	const valid =
		resolved.from < now && (!resolved.to || resolved.from < resolved.to);
	// Short bound labels: the year only when it is not the current one.
	const format = (date: Date) =>
		new Intl.DateTimeFormat(locale, {
			month: "short",
			day: "numeric",
			...(new Intl.DateTimeFormat("en", {
				year: "numeric",
				timeZone: zone,
			}).format(date) ===
			new Intl.DateTimeFormat("en", { year: "numeric", timeZone: zone }).format(
				now,
			)
				? {}
				: { year: "numeric" }),
			...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
			timeZone: zone,
		}).format(date);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (valid) onApply(resolved);
	};
	const title =
		kind === "since"
			? withTime
				? m.range_select_date_time()
				: m.range_select_date()
			: withTime
				? m.range_select_range_time()
				: m.range_select_range();
	// Without time, a range is two months side by side, picked as start then end day.
	const months = kind === "between" && !withTime;
	const summary = months
		? m.range_selected({
				range:
					dayStart(start, zone).getTime() === dayStart(end, zone).getTime()
						? new Intl.DateTimeFormat(locale, {
								dateStyle: "long",
								timeZone: zone,
							}).format(start)
						: new Intl.DateTimeFormat(locale, {
								dateStyle: "long",
								timeZone: zone,
							}).formatRange(start, end),
			})
		: undefined;
	return (
		<form
			onSubmit={submit}
			className={cn(
				"flex flex-col",
				months ? "w-[42rem]" : "w-[28rem]",
				"max-w-full",
			)}
		>
			<PanelHeader title={title} onClose={onClose} />
			{kind === "between" && !months && (
				<ToggleGroup
					type="single"
					variant="outline"
					value={active}
					onValueChange={(next) => {
						if (next) setActive(next as Bound);
					}}
					aria-label={m.range_select_range_time()}
					className="flex w-full gap-2 border-b px-4 py-2.5"
				>
					{(["start", "end"] as const).map((bound) => (
						<ToggleGroupItem
							key={bound}
							value={bound}
							className="min-w-0 flex-1 justify-start px-2.5 font-normal data-[state=on]:border-primary data-[state=on]:ring-1 data-[state=on]:ring-primary"
						>
							<span className="truncate">
								{(bound === "start" ? m.range_start_label : m.range_end_label)({
									time: format(bound === "start" ? start : end),
								})}
							</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			)}
			<div className={cn("flex justify-center", months ? "min-h-76" : "h-76")}>
				<Calendar
					key={months ? "months" : "month"}
					// Each panel holds instants; the calendar shows and picks days in `zone`.
					timeZone={zone}
					locale={locale.startsWith("fr") ? fr : enUS}
					{...(kind === "between"
						? {
								mode: "range" as const,
								selected: { from: start, to: end },
								onSelect: (_: unknown, day: Date | undefined) => {
									if (!day) return;
									if (months) {
										// First click starts a new range; the second closes it in either order.
										if (active === "start") {
											setStart(atTime(day, wallTime(start, zone), zone));
											setEnd(atTime(day, wallTime(end, zone), zone));
											setActive("end");
										} else {
											const picked = dayStart(day, zone);
											if (picked < dayStart(start, zone)) {
												setEnd(atTime(start, wallTime(end, zone), zone));
												setStart(atTime(day, wallTime(start, zone), zone));
											} else setEnd(atTime(day, wallTime(end, zone), zone));
											setActive("start");
										}
										return;
									}
									const next = atTime(day, wallTime(current, zone), zone);
									update(next);
									// Picking a start moves on to the end, as most range pickers do.
									if (active === "start") {
										setActive("end");
										if (next > end)
											setEnd(atTime(day, wallTime(end, zone), zone));
									} else if (next < start)
										setStart(atTime(day, wallTime(start, zone), zone));
								},
							}
						: {
								mode: "single" as const,
								required: true,
								selected: start,
								onSelect: (day: Date | undefined) => {
									if (day) setStart(atTime(day, wallTime(start, zone), zone));
								},
							})}
					numberOfMonths={months ? 2 : 1}
					defaultMonth={
						months
							? new Date(end.getFullYear(), end.getMonth() - 1, 1)
							: current
					}
					disabled={{ after: now }}
					className="shrink-0 p-3 [--cell-size:--spacing(9)]"
				/>
				{withTime && (
					<TimeColumns hours={hours} minutes={minutes} onChange={setWall} />
				)}
			</div>
			<p className="px-4 pb-2 text-xs text-muted-foreground">
				{m.range_zone({ zone })}
			</p>
			<PanelFooter onCancel={onCancel} disabled={!valid} summary={summary}>
				<div className="flex h-8 items-center gap-2 rounded-md border px-2.5">
					<Label htmlFor={`${id}-time`}>{m.range_include_time()}</Label>
					<Switch
						id={`${id}-time`}
						checked={withTime}
						onCheckedChange={setWithTime}
					/>
				</div>
			</PanelFooter>
		</form>
	);
}
