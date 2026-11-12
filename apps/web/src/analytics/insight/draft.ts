import {
	type DateRange,
	DEFAULT_RANGE,
	resolveRange,
} from "../../components/date-range/date-range";
import {
	type AnalyticsQuery,
	type Calculation,
	type Combine,
	type Comparison,
	DEFAULT_SERIES_LIMIT,
	type Filter,
	INTERVALS,
	type Interval,
	MAX_BUCKETS,
	MAX_MEASURES,
	MAX_RANGE_SECONDS,
} from "../contracts";

// An insight being edited. It is plain JSON so it can live in the URL and later be
// saved; `toQuery` turns it into the server's query object when it runs.

export const SERIES_NAMES = Array.from({ length: MAX_MEASURES }, (_, index) =>
	String.fromCharCode(65 + index),
);
/** The longest draft text accepted from a URL or for saving. */
export const MAX_DRAFT_LENGTH = 16_000;
export const MAX_RANGE_DAYS = MAX_RANGE_SECONDS / 86_400;

export interface DraftSeries {
	name: string;
	metric?: string;
	calculation: Calculation;
	combine: Combine;
	filters: Filter[];
	/** Set on series a calculated metric added, so choosing another replaces them together. */
	source?: string;
}

export interface DraftFormula {
	/** Combines series by letter, such as `(1 - A / B) * 100`. */
	expression: string;
	/** Names the formula in legends, such as "Memory usage". */
	name?: string;
	source?: string;
}

export type DisplayType =
	| "line"
	| "area"
	| "bar"
	| "stacked"
	| "stat"
	| "table";
export type DisplayUnit = "auto" | "percent" | "ratio" | "bytes" | "seconds";

export interface Display {
	type: DisplayType;
	unit: DisplayUnit;
	logScale: boolean;
	beginAtZero: boolean;
	goal?: number;
}

export interface InsightDraft {
	series: DraftSeries[];
	/** Shown instead of the series when any are present. */
	formulas: DraftFormula[];
	filters: Filter[];
	groupBy?: string;
	limit: number;
	other: boolean;
	/** Collapses the breakdown's groups into one line, such as p99 across nodes. */
	aggregate?: Combine;
	range: DateRange;
	interval: Interval | "auto";
	compare?: Comparison;
	display: Display;
}

export const DEFAULT_DISPLAY: Display = {
	type: "line",
	unit: "auto",
	logScale: false,
	beginAtZero: true,
};

export function newSeries(name: string): DraftSeries {
	return { name, calculation: "avg", combine: "avg", filters: [] };
}

export const DEFAULT_DRAFT: InsightDraft = {
	series: [newSeries("A")],
	formulas: [],
	filters: [],
	limit: DEFAULT_SERIES_LIMIT,
	other: true,
	range: DEFAULT_RANGE,
	interval: "auto",
	display: DEFAULT_DISPLAY,
};

/** The next unused series letter, or null when every one is taken. */
export function nextSeriesName(series: DraftSeries[]) {
	if (series.length >= MAX_MEASURES) return null;
	const used = new Set(series.map((entry) => entry.name));
	return SERIES_NAMES.find((name) => !used.has(name)) ?? null;
}

/** Removes a series; one a calculated metric added goes with its siblings and formula. */
export function removeSeries(draft: InsightDraft, name: string): InsightDraft {
	const source = draft.series.find((entry) => entry.name === name)?.source;
	const removed = (entry: { name?: string; source?: string }) =>
		source ? entry.source === source : entry.name === name;
	const series = draft.series.filter((entry) => !removed(entry));
	return {
		...draft,
		series: series.length ? series : [newSeries("A")],
		formulas: draft.formulas.filter((formula) => !removed(formula)),
	};
}

/** The finest interval that keeps a range to roughly 150 buckets and under the limit. */
export function autoInterval(from: Date, to: Date): Interval {
	const seconds = (to.getTime() - from.getTime()) / 1000;
	const intervals = Object.entries(INTERVALS) as [Interval, number][];
	return (
		intervals.find(([, step]) => seconds / step <= 150)?.[0] ??
		intervals.at(-1)?.[0] ??
		"1d"
	);
}

/** The interval a query uses: the chosen one when it fits the range, otherwise automatic. */
export function effectiveInterval(
	chosen: Interval | "auto",
	from: Date,
	to: Date,
): Interval {
	return chosen !== "auto" && intervalFits(chosen, from, to)
		? chosen
		: autoInterval(from, to);
}

/** Whether an interval keeps a range under the bucket limit. */
export function intervalFits(interval: Interval, from: Date, to: Date) {
	return (
		(to.getTime() - from.getTime()) / 1000 / INTERVALS[interval] <= MAX_BUCKETS
	);
}

/** The server name of each formula: F1, F2… by position in the draft. */
export function formulaId(index: number) {
	return `F${index + 1}`;
}

/** Display names by server formula name, for legends and tables. */
export function formulaNames(draft: InsightDraft) {
	return Object.fromEntries(
		draft.formulas.flatMap((formula, index) =>
			formula.name?.trim() ? [[formulaId(index), formula.name.trim()]] : [],
		),
	);
}

function formulas(draft: InsightDraft) {
	return draft.formulas.flatMap((formula, index) =>
		formula.expression.trim()
			? [{ name: formulaId(index), expression: formula.expression.trim() }]
			: [],
	);
}

/** The query for a draft, or null until every series has a metric. */
export function toQuery(
	draft: InsightDraft,
	now: Date,
	zone: string,
	locale: string,
): AnalyticsQuery | null {
	if (!draft.series.length || draft.series.some((entry) => !entry.metric))
		return null;
	const resolved = resolveRange(draft.range, now, zone, locale);
	const from = resolved.from,
		to = resolved.to ?? now;
	const interval = effectiveInterval(draft.interval, from, to);
	// A table shows one value per series over the whole range; every other view is a timeseries.
	const table = draft.display.type === "table";
	return {
		shape: table ? "table" : "timeseries",
		range: { from: from.toISOString(), to: to.toISOString() },
		...(table ? {} : { interval }),
		measures: draft.series.map((entry) => ({
			name: entry.name,
			metric: entry.metric as string,
			calculation: entry.calculation,
			combine: entry.combine,
			filters: entry.filters,
		})),
		...(formulas(draft).length ? { formulas: formulas(draft) } : {}),
		filters: draft.filters,
		groupBy: draft.groupBy ? [draft.groupBy] : [],
		limit: draft.limit,
		other: draft.other,
		...(draft.groupBy && draft.aggregate ? { aggregate: draft.aggregate } : {}),
		...(draft.compare ? { compare: draft.compare } : {}),
	};
}

// Dates inside a range are ISO strings in the URL.
type SerializedRange =
	| Exclude<DateRange, { from: Date } | { at: Date }>
	| { kind: "since"; from: string }
	| { kind: "between"; from: string; to: string }
	| {
			kind: "jump";
			at: string;
			minutes: number;
			anchor: "around" | "before" | "after";
	  };

function serializeRange(range: DateRange): SerializedRange {
	switch (range.kind) {
		case "since":
			return { kind: "since", from: range.from.toISOString() };
		case "between":
			return {
				kind: "between",
				from: range.from.toISOString(),
				to: range.to.toISOString(),
			};
		case "jump":
			return { ...range, at: range.at.toISOString() };
		default:
			return range;
	}
}

function deserializeRange(range: SerializedRange): DateRange {
	switch (range.kind) {
		case "since":
			return { kind: "since", from: new Date(range.from) };
		case "between":
			return {
				kind: "between",
				from: new Date(range.from),
				to: new Date(range.to),
			};
		case "jump":
			return { ...range, at: new Date(range.at) };
		default:
			return range;
	}
}

/** The URL form of a draft. */
export function encodeDraft(draft: InsightDraft): string {
	return JSON.stringify({ ...draft, range: serializeRange(draft.range) });
}

function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : 1))
				.map(([key, entry]) => [key, sortedKeys(entry)]),
		);
	return value;
}

/** Whether two drafts show the same insight, whatever their key order. */
export function sameDraft(left: InsightDraft, right: InsightDraft) {
	const canonical = (draft: InsightDraft) =>
		JSON.stringify(sortedKeys(JSON.parse(encodeDraft(draft))));
	return canonical(left) === canonical(right);
}

/**
 * Reads a draft from the URL. Anything unreadable falls back to the default; the server
 * validates the resulting query regardless, so this only protects the editor's shape.
 */
export function decodeDraft(text: unknown): InsightDraft {
	if (typeof text !== "string" || text.length > MAX_DRAFT_LENGTH)
		return DEFAULT_DRAFT;
	try {
		const value = JSON.parse(text) as InsightDraft & { range: SerializedRange };
		if (
			!Array.isArray(value.series) ||
			!value.series.length ||
			value.series.length > MAX_MEASURES ||
			!Array.isArray(value.filters) ||
			typeof value.range?.kind !== "string" ||
			typeof value.display?.type !== "string"
		)
			return DEFAULT_DRAFT;
		const range = deserializeRange(value.range);
		const dates = [
			"from" in range ? range.from : null,
			"to" in range ? range.to : null,
			"at" in range ? range.at : null,
		];
		if (dates.some((date) => date && !Number.isFinite(date.getTime())))
			return DEFAULT_DRAFT;
		return {
			...DEFAULT_DRAFT,
			...value,
			formulas: Array.isArray(value.formulas)
				? value.formulas.filter(
						(formula) => typeof formula?.expression === "string",
					)
				: [],
			series: value.series.map((entry) => ({
				...newSeries(entry.name),
				...entry,
				filters: Array.isArray(entry.filters) ? entry.filters : [],
			})),
			range,
			display: { ...DEFAULT_DISPLAY, ...value.display },
		};
	} catch {
		return DEFAULT_DRAFT;
	}
}
