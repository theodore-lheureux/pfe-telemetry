import {
	type DateRange,
	DEFAULT_RANGE,
	deserializeRange,
	resolveRange,
	type SerializedRange,
	serializeRange,
} from "../../components/date-range/date-range";
import {
	type AnalyticsQuery,
	type Calculation,
	type Combine,
	type Comparison,
	DEFAULT_SERIES_LIMIT,
	type Filter,
	type Interval,
	MAX_MEASURES,
	MAX_RANGE_SECONDS,
	type Spread,
} from "../contracts";
import { breakdownFields } from "../fields";
import { effectiveInterval } from "../intervals";

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
}

export interface DraftFormula {
	/** Combines series by letter, such as `(1 - A / B) * 100`. */
	expression: string;
	/** Names the formula in legends, such as "Memory usage". */
	name?: string;
}

export const DISPLAY_TYPES = [
	"line",
	"area",
	"bar",
	"stacked",
	"heatmap",
	"grid",
	"stat",
	"table",
] as const;
export type DisplayType = (typeof DISPLAY_TYPES)[number];
export type DisplayUnit =
	| "auto"
	| "none"
	| "seconds"
	| "milliseconds"
	| "nanoseconds"
	| "percent"
	| "ratio"
	| "bytes"
	| "currency"
	| "short"
	| "prefix"
	| "postfix";

export type LegendPosition = "bottom" | "right";
export type LineStyle = "straight" | "smooth";

export interface Display {
	type: DisplayType;
	unit: DisplayUnit;
	/** The text a custom prefix or postfix unit adds to each value. */
	unitAffix?: string;
	logScale: boolean;
	beginAtZero: boolean;
	goal?: number;
	/** Labels each point with its value. */
	showValues?: boolean;
	/** Lists the series beside the chart, where no table already names them. */
	legend?: LegendPosition;
	xLabel?: string;
	yLabel?: string;
	/** The Y axis' upper bound; automatic when absent. */
	yMax?: number;
	yMin?: number;
	lineStyle?: LineStyle;
	/** A least-squares line through each series. */
	trend?: boolean;
	/** The mean of this many buckets, ending at each one, drawn over each series. */
	movingAverage?: number;
	/** A band around each line across the sources it combines. */
	spread?: Spread;
	/** The axis-free chart behind a Number insight. */
	numberChart?: "none" | "line" | "area" | "bar";
}

export const MAX_AXIS_LABEL = 60;
export const MAX_UNIT_AFFIX = 12;
export const MAX_MOVING_AVERAGE = 100;

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
export function draftMetricNames(draft: InsightDraft) {
	return draft.series.flatMap((series) =>
		series.metric ? [series.metric] : [],
	);
}

/** A Number insight has one output: a measure or a formula over input measures. */
export function withDisplay(
	draft: InsightDraft,
	display: Display,
): InsightDraft {
	if (display.type !== "stat") return { ...draft, display };
	const { groupBy: _group, aggregate: _aggregate, ...rest } = draft;
	const { spread: _spread, ...numberDisplay } = display;
	const formulas = draft.formulas.slice(0, 1);
	return {
		...rest,
		series: formulas.length ? draft.series : draft.series.slice(0, 1),
		formulas,
		display: numberDisplay,
	};
}

/** The next unused series letter, or null when every one is taken. */
export function nextSeriesName(series: DraftSeries[]) {
	if (series.length >= MAX_MEASURES) return null;
	const used = new Set(series.map((entry) => entry.name));
	return SERIES_NAMES.find((name) => !used.has(name)) ?? null;
}

/** Removes one input series. */
export function removeSeries(draft: InsightDraft, name: string): InsightDraft {
	const series = draft.series.filter((entry) => entry.name !== name);
	return withDisplay(
		{
			...draft,
			series: series.length ? series : [newSeries("A")],
		},
		draft.display,
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
	input: InsightDraft,
	now: Date,
	zone: string,
	locale: string,
): AnalyticsQuery | null {
	const draft = withDisplay(input, input.display);
	const heatmap = draft.display.type === "heatmap";
	if (!draft.series.length || draft.series.some((entry) => !entry.metric))
		return null;
	if (
		draft.display.type === "stat" &&
		draft.formulas.length &&
		!formulas(draft).length
	)
		return null;
	const resolved = resolveRange(draft.range, now, zone, locale);
	const from = resolved.from,
		to = resolved.to ?? now;
	const interval = effectiveInterval(draft.interval, from, to);
	// A table shows one value per series over the whole range; every other view is a timeseries.
	const table = draft.display.type === "table";
	const grouped = draft.display.type !== "stat" && !!draft.groupBy;
	return {
		shape: table ? "table" : "timeseries",
		...(heatmap ? { heatmap: true as const } : {}),
		range: { from: from.toISOString(), to: to.toISOString() },
		...(table ? {} : { interval }),
		// A heatmap shows a histogram whatever its calculation, so each one is read once.
		measures: draft.series
			.filter(
				(entry, index, all) =>
					!heatmap ||
					all.findIndex(
						(other) =>
							other.metric === entry.metric &&
							JSON.stringify(other.filters) === JSON.stringify(entry.filters),
					) === index,
			)
			.map((entry) => ({
				name: entry.name,
				metric: entry.metric as string,
				calculation: entry.calculation,
				combine: entry.combine,
				filters: entry.filters,
			})),
		...(!heatmap && formulas(draft).length
			? { formulas: formulas(draft) }
			: {}),
		filters: draft.filters,
		groupBy: grouped ? breakdownFields(draft.groupBy as string) : [],
		limit: draft.limit,
		other: !heatmap && draft.other,
		...(!heatmap && grouped && draft.aggregate
			? { aggregate: draft.aggregate }
			: {}),
		...(!heatmap && draft.compare ? { compare: draft.compare } : {}),
		...(!heatmap &&
		draft.display.spread &&
		!table &&
		draft.display.type !== "stat"
			? { spread: draft.display.spread }
			: {}),
	};
}

/** The URL form of a draft. */
export function encodeDraft(draft: InsightDraft): string {
	return JSON.stringify({
		...withDisplay(draft, draft.display),
		range: serializeRange(draft.range),
	});
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
			!DISPLAY_TYPES.includes(value.display?.type)
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
		return withDisplay(
			{
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
			},
			{ ...DEFAULT_DISPLAY, ...value.display },
		);
	} catch {
		return DEFAULT_DRAFT;
	}
}
