import { TZDate } from "@date-fns/tz";
import { m } from "@recount/i18n/messages";
import {
	addDays,
	addMonths,
	addWeeks,
	startOfDay,
	startOfMonth,
	startOfWeek,
	startOfYear,
	subDays,
	subHours,
	subMinutes,
	subMonths,
	subWeeks,
	subYears,
} from "date-fns";

// The Explorer's time selection. It stays a description until a query runs, so relative
// choices such as "Last hour" or "Today" resolve against the time of each reload.

export const RANGE_UNITS = [
	"minutes",
	"hours",
	"days",
	"weeks",
	"months",
	"years",
] as const;
export type RangeUnit = (typeof RANGE_UNITS)[number];
export const CALENDAR_PRESETS = [
	"today",
	"yesterday",
	"last_week",
	"last_month",
	"this_week",
	"this_month",
	"this_year",
	"all_time",
] as const;
export type CalendarPreset = (typeof CALENDAR_PRESETS)[number];
export const JUMP_WINDOWS = [1, 5, 15, 60] as const;
export type JumpAnchor = "around" | "before" | "after";

export type DateRange =
	| { kind: "last"; count: number; unit: RangeUnit }
	| { kind: "preset"; preset: CalendarPreset }
	| { kind: "since"; from: Date }
	| { kind: "between"; from: Date; to: Date }
	| { kind: "jump"; at: Date; minutes: number; anchor: JumpAnchor };

export const DEFAULT_RANGE: DateRange = {
	kind: "last",
	count: 1,
	unit: "hours",
};
export function isDefaultRange(range: DateRange) {
	return range.kind === "last" && range.count === 1 && range.unit === "hours";
}

/** Relative choices listed above the calendar presets, in menu order. */
export const LAST_PRESETS: { count: number; unit: RangeUnit }[] = [
	{ count: 1, unit: "hours" },
	{ count: 24, unit: "hours" },
	{ count: 7, unit: "days" },
	{ count: 14, unit: "days" },
	{ count: 30, unit: "days" },
	{ count: 90, unit: "days" },
];

export interface ResolvedRange {
	from: Date;
	/** Absent for ranges that end now. */
	to?: Date;
}

const SUBTRACT = {
	minutes: subMinutes,
	hours: subHours,
	days: subDays,
	weeks: subWeeks,
	months: subMonths,
	years: subYears,
} satisfies Record<RangeUnit, (date: Date, amount: number) => Date>;

function weekStartsOn(locale: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
	try {
		const info = new Intl.Locale(locale) as Intl.Locale & {
			getWeekInfo?: () => { firstDay: number };
			weekInfo?: { firstDay: number };
		};
		const first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1;
		return (first % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
	} catch {
		return 1;
	}
}

/** Resolves a selection to absolute bounds; calendar periods follow `timeZone`. */
export function resolveRange(
	range: DateRange,
	now: Date,
	timeZone: string,
	locale: string,
): ResolvedRange {
	// Zoned dates serialize with an offset; RPCs and comparisons use plain instants.
	const { from, to } = resolveZoned(range, now, timeZone, locale);
	return to
		? { from: new Date(from.getTime()), to: new Date(to.getTime()) }
		: { from: new Date(from.getTime()) };
}

function resolveZoned(
	range: DateRange,
	now: Date,
	timeZone: string,
	locale: string,
): ResolvedRange {
	switch (range.kind) {
		case "last":
			return { from: SUBTRACT[range.unit](now, range.count) };
		case "since":
			return { from: range.from };
		case "between":
			return range.to.getTime() > now.getTime()
				? { from: range.from }
				: { from: range.from, to: range.to };
		case "jump": {
			const span = range.minutes * 60_000,
				at = range.at.getTime();
			const from =
				range.anchor === "after"
					? at
					: range.anchor === "before"
						? at - span
						: at - span / 2;
			const to = from + span;
			return to >= now.getTime()
				? { from: new Date(from) }
				: { from: new Date(from), to: new Date(to) };
		}
		case "preset":
			break;
	}
	const zoned = new TZDate(now.getTime(), timeZone);
	const week = { weekStartsOn: weekStartsOn(locale) };
	const day = startOfDay(zoned);
	switch (range.preset) {
		case "today":
			return { from: day };
		case "yesterday":
			return { from: addDays(day, -1), to: day };
		case "this_week":
			return { from: startOfWeek(zoned, week) };
		case "last_week": {
			const start = startOfWeek(zoned, week);
			return { from: addWeeks(start, -1), to: start };
		}
		case "this_month":
			return { from: startOfMonth(zoned) };
		case "last_month": {
			const start = startOfMonth(zoned);
			return { from: addMonths(start, -1), to: start };
		}
		case "this_year":
			return { from: startOfYear(zoned) };
		case "all_time":
			return { from: new Date(0) };
	}
}

/** The start of the day after `date` in `timeZone`, the exclusive end of a picked day. */
export function nextDayStart(date: Date, timeZone: string) {
	return new Date(
		addDays(startOfDay(new TZDate(date.getTime(), timeZone)), 1).getTime(),
	);
}

/** The start of `date`'s day in `timeZone`. */
export function dayStart(date: Date, timeZone: string) {
	return new Date(startOfDay(new TZDate(date.getTime(), timeZone)).getTime());
}

/** `date`'s day in `timeZone` at the wall-clock time `hhmm`. */
export function atTime(date: Date, hhmm: string, timeZone: string) {
	const day = new TZDate(date.getTime(), timeZone);
	const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
	return new Date(
		TZDate.tz(
			timeZone,
			day.getFullYear(),
			day.getMonth(),
			day.getDate(),
			hours,
			minutes,
		).getTime(),
	);
}

/** The wall-clock `HH:MM` of `date` in `timeZone`. */
export function wallTime(date: Date, timeZone: string) {
	const day = new TZDate(date.getTime(), timeZone);
	return `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
}

const PRESET_LABEL: Record<CalendarPreset, () => string> = {
	today: m.range_today,
	yesterday: m.range_yesterday,
	last_week: m.range_last_week,
	last_month: m.range_last_month,
	this_week: m.range_this_week,
	this_month: m.range_this_month,
	this_year: m.range_this_year,
	all_time: m.range_all_time,
};
const UNIT: Record<RangeUnit, string> = {
	minutes: "minute",
	hours: "hour",
	days: "day",
	weeks: "week",
	months: "month",
	years: "year",
};

export function presetLabel(preset: CalendarPreset) {
	return PRESET_LABEL[preset]();
}

export function durationLabel(count: number, unit: RangeUnit, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit: UNIT[unit],
		unitDisplay: "long",
	}).format(count);
}

export function lastLabel(count: number, unit: RangeUnit, locale: string) {
	if (count === 1 && unit === "hours") return m.insight_range_1h();
	return m.range_last({ duration: durationLabel(count, unit, locale) });
}

/** A short trigger label for any selection. */
export function rangeLabel(range: DateRange, locale: string, timeZone: string) {
	const time = (date: Date, withTime = true) =>
		new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			...(withTime ? { timeStyle: "short" } : {}),
			timeZone,
		}).format(date);
	switch (range.kind) {
		case "last":
			return lastLabel(range.count, range.unit, locale);
		case "preset":
			return presetLabel(range.preset);
		case "since":
			return m.range_since({ time: time(range.from) });
		case "between":
			return new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "short",
				timeZone,
			}).formatRange(range.from, range.to);
		case "jump":
			return m.range_jump_label({
				time: time(range.at),
				window: durationLabel(range.minutes, "minutes", locale),
			});
	}
}

/** Reads an ISO 8601 time or Unix seconds or milliseconds; null when unreadable. */
export function parseTimestamp(value: string): Date | null {
	const text = value.trim();
	if (!text) return null;
	if (/^\d{1,16}$/.test(text)) {
		const number = Number(text);
		// Ten digits or fewer are seconds; more are milliseconds.
		const date = new Date(text.length <= 10 ? number * 1000 : number);
		return Number.isFinite(date.getTime()) ? date : null;
	}
	if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
	const date = new Date(text);
	return Number.isFinite(date.getTime()) ? date : null;
}
