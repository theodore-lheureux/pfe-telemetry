import { m } from "@recount/i18n/messages";
import {
	AreaChartIcon,
	BarChart3Icon,
	BarChartBigIcon,
	Grid2X2Icon,
	HashIcon,
	LayoutGridIcon,
	LineChartIcon,
	type LucideIcon,
	TableIcon,
} from "lucide-react";
import { type FormattedNumber, formatNumeric } from "../../lib/number-format";
import type {
	Calculation,
	Combine,
	Interval,
	QueryResult,
	SeriesResult,
} from "../contracts";
import { metricLabel } from "../definition-labels";
import {
	countNoun,
	countText,
	formatMetricValue,
	rateUnit,
} from "../metric-units";
import { isHistogramPercentile } from "../validation";
import type { Display, DisplayType, DisplayUnit, InsightDraft } from "./draft";

export const CALCULATION_LABEL: Record<Calculation, () => string> = {
	last: m.insight_calc_last,
	avg: m.insight_calc_avg,
	min: m.insight_calc_min,
	max: m.insight_calc_max,
	rate: m.insight_calc_rate,
	increase: m.insight_calc_increase,
	count: m.histogram_subject_observations,
	p50: () => "p50",
	p75: () => "p75",
	p90: () => "p90",
	p95: () => "p95",
	p99: () => "p99",
};
/** A calculation's name; a histogram's count is named by what it counts, such as Busy processes. */
export function calculationLabel(calculation: Calculation, unit = "") {
	if (calculation !== "count") return CALCULATION_LABEL[calculation]();
	const noun = countNoun(unit);
	return noun.charAt(0).toLocaleUpperCase() + noun.slice(1);
}
/** How sources combine, phrased to read after the calculation: "Rate per second · Sum of all sources". */
export const COMBINE_OPTION_LABEL: Record<Combine, () => string> = {
	sum: m.insight_combine_option_sum,
	avg: m.insight_combine_option_avg,
	count: m.insight_combine_option_count,
	min: m.insight_combine_option_min,
	max: m.insight_combine_option_max,
	p50: m.insight_combine_option_p50,
	p90: m.insight_combine_option_p90,
	p95: m.insight_combine_option_p95,
	p99: m.insight_combine_option_p99,
};
/** How a breakdown's groups were collapsed into one line, as its legend reads. */
export const AGGREGATE_LABEL: Record<Combine, () => string> = {
	sum: m.insight_aggregate_sum,
	avg: m.insight_aggregate_avg,
	count: m.insight_aggregate_count,
	min: m.insight_aggregate_min,
	max: m.insight_aggregate_max,
	p50: m.insight_aggregate_p50,
	p90: m.insight_aggregate_p90,
	p95: m.insight_aggregate_p95,
	p99: m.insight_aggregate_p99,
};
/** The combine menu's sections: aggregations, then percentiles across sources. */
export const COMBINE_GROUPS: { label: () => string; values: Combine[] }[] = [
	{
		label: m.insight_combine_aggregations,
		values: ["sum", "avg", "count", "min", "max"],
	},
	{
		label: m.insight_combine_percentiles,
		values: ["p50", "p90", "p95", "p99"],
	},
];
export const INTERVAL_LABEL: Record<Interval, () => string> = {
	"2s": m.insight_interval_2s,
	"10s": m.insight_interval_10s,
	"1m": m.insight_interval_1m,
	"5m": m.insight_interval_5m,
	"15m": m.insight_interval_15m,
	"1h": m.insight_interval_1h,
	"1d": m.insight_interval_1d,
};
/** Interval wording after "per", as the interval selects' triggers show it. */
export const PER_INTERVAL_LABEL: Record<Interval, () => string> = {
	"2s": m.insight_per_2s,
	"10s": m.insight_per_10s,
	"1m": m.insight_per_1m,
	"5m": m.insight_per_5m,
	"15m": m.insight_per_15m,
	"1h": m.insight_per_1h,
	"1d": m.insight_per_1d,
};
export const DISPLAY_ICON: Record<DisplayType, LucideIcon> = {
	line: LineChartIcon,
	area: AreaChartIcon,
	bar: BarChart3Icon,
	stacked: BarChartBigIcon,
	heatmap: Grid2X2Icon,
	grid: LayoutGridIcon,
	stat: HashIcon,
	table: TableIcon,
};
export const DISPLAY_LABEL: Record<DisplayType, () => string> = {
	line: m.insight_display_line,
	area: m.insight_display_area,
	bar: m.insight_display_bar,
	stacked: m.insight_display_stacked,
	heatmap: m.insight_display_heatmap,
	grid: m.insight_display_grid,
	stat: m.insight_display_stat,
	table: m.insight_display_table,
};
export const UNIT_LABEL: Record<DisplayUnit, () => string> = {
	auto: m.insight_unit_auto,
	none: m.insight_unit_none,
	seconds: m.insight_unit_seconds,
	milliseconds: m.insight_unit_milliseconds,
	nanoseconds: m.insight_unit_nanoseconds,
	percent: m.insight_unit_percent,
	ratio: m.insight_unit_ratio,
	bytes: m.insight_unit_bytes,
	currency: m.insight_unit_currency,
	short: m.insight_unit_short,
	prefix: m.insight_unit_prefix,
	postfix: m.insight_unit_postfix,
};
/** Units that format values themselves, in menu order; custom text units follow them. */
export const FORMAT_UNITS: DisplayUnit[] = [
	"auto",
	"none",
	"seconds",
	"milliseconds",
	"nanoseconds",
	"percent",
	"ratio",
	"bytes",
	"currency",
	"short",
];
export const CUSTOM_UNITS: DisplayUnit[] = ["prefix", "postfix"];

/**
 * A readable value. With the automatic unit, measures keep their stored unit (rates per
 * second of it) and formulas show plain numbers; a chosen unit applies to everything.
 */
export function formatValue(
	value: number | null,
	display: Pick<Display, "unit" | "unitAffix">,
	stored: { unit: string; calculation: Calculation } | null,
	locale: string,
) {
	return formatValueDetails(value, display, stored, locale).text;
}

function affixed(
	number: FormattedNumber,
	prefix: string,
	suffix: string,
): FormattedNumber {
	return { ...number, text: `${prefix}${number.text}${suffix}` };
}

export function formatValueDetails(
	value: number | null,
	{ unit, unitAffix = "" }: Pick<Display, "unit" | "unitAffix">,
	stored: { unit: string; calculation: Calculation } | null,
	locale: string,
	minimumFractionDigits = 0,
	/** Leaves out a count's subject, which a header or axis title names once. */
	bare = false,
): FormattedNumber {
	if (value === null) return { text: "—", fractionDigits: 0 };
	// Small values keep two significant digits, so 0.0015 does not read as 0.002.
	const number = (digits = 3) =>
		formatNumeric(
			value,
			locale,
			{
				maximumFractionDigits:
					value !== 0 && Math.abs(value) < 1
						? Math.min(
								20,
								Math.max(digits, Math.ceil(-Math.log10(Math.abs(value))) + 1),
							)
						: digits,
			},
			minimumFractionDigits,
		);
	switch (unit) {
		case "none":
			return number();
		case "milliseconds":
			return formatMetricValue(value / 1e3, "s", locale, minimumFractionDigits);
		case "nanoseconds":
			return formatMetricValue(value / 1e9, "s", locale, minimumFractionDigits);
		case "currency":
			return formatNumeric(
				value,
				locale,
				{
					style: "currency",
					currency: "USD",
				},
				minimumFractionDigits,
			);
		case "short":
			return formatNumeric(
				value,
				locale,
				{
					notation: "compact",
					maximumFractionDigits: 1,
				},
				minimumFractionDigits,
			);
		case "prefix":
			return affixed(number(), unitAffix, "");
		case "postfix":
			return affixed(number(), "", unitAffix);
		case "percent":
			return affixed(number(1), "", " %");
		case "ratio":
			return formatNumeric(
				value,
				locale,
				{
					style: "percent",
					maximumFractionDigits: 1,
				},
				minimumFractionDigits,
			);
		case "bytes":
			return formatMetricValue(value, "By", locale, minimumFractionDigits);
		case "seconds":
			return formatMetricValue(value, "s", locale, minimumFractionDigits);
		case "auto":
			break;
	}
	if (!stored) return number();
	// A count of observations is a number of subjects, whatever unit they are measured in.
	if (stored.calculation === "count") {
		const counted = number(1);
		if (bare) return counted;
		return {
			...counted,
			text: countText(stored.unit, counted.text, value, locale),
		};
	}
	const storedUnit =
		stored.calculation === "rate" ? rateUnit(stored.unit) : stored.unit;
	return formatMetricValue(value, storedUnit, locale, minimumFractionDigits);
}

/** The stored unit and calculation behind a series; null for formulas. */
export function seriesSource(result: QueryResult, series: SeriesResult) {
	return (
		result.measures.find((measure) => measure.name === series.measure) ?? null
	);
}

/** Display names by server formula name; unnamed formulas show their expression. */
export type FormulaNames = Record<string, string>;

function plotted(
	result: QueryResult,
	series: SeriesResult,
	names: FormulaNames,
) {
	const measure = seriesSource(result, series);
	if (measure) return measureText(result, measure);
	if (names[series.measure]) return names[series.measure];
	const expression = result.formulas.find(
		(formula) => formula.name === series.measure,
	)?.expression;
	// A formula that is just one series, such as "A", reads as that series.
	const alone = result.measures.find((entry) => entry.name === expression);
	if (alone) return `${alone.name} · ${metricLabel(alone.metric, alone.label)}`;
	return expression ?? series.measure;
}

/** Measures of one metric that differ only by calculation, such as its p50, p95 and p99. */
function calculationsOnly(result: QueryResult) {
	const [first] = result.measures;
	return (
		result.measures.length > 1 &&
		!result.formulas.length &&
		result.measures.every((measure) => measure.metric === first.metric) &&
		new Set(result.measures.map((measure) => measure.calculation)).size ===
			result.measures.length
	);
}

function measureText(
	result: QueryResult,
	measure: QueryResult["measures"][number],
) {
	if (calculationsOnly(result))
		return calculationLabel(measure.calculation, measure.unit);
	if (isHistogramPercentile(measure.calculation))
		return `${metricLabel(measure.metric, measure.label)} · ${calculationLabel(measure.calculation, measure.unit)}`;
	if (result.measures.length > 1)
		return `${measure.name} · ${metricLabel(measure.metric, measure.label)}`;
	return metricLabel(measure.metric, measure.label);
}

export function groupText(
	series: SeriesResult,
	groupLabel: (value: string | null) => string,
) {
	if (series.other) return m.insight_other();
	if (!series.group.length) return null;
	// Extra keys name the group, such as a process name before its ID.
	const shown = series.group.filter(
		(value, index) => value !== null || index === series.group.length - 1,
	);
	return shown.map((value) => groupLabel(value)).join(" · ");
}

/**
 * "A · Node CPU time · node-1", with "Other" and "previous" marked. When one formula or
 * measure is broken down, every series shares it, so the group alone names a series.
 */
export function seriesLabel(
	result: QueryResult,
	series: SeriesResult,
	groupLabel: (value: string | null) => string,
	names: FormulaNames = {},
) {
	const shown = result.formulas.length || result.measures.length;
	const group = result.aggregate
		? AGGREGATE_LABEL[result.aggregate]()
		: groupText(series, groupLabel);
	const parts = !group || shown > 1 ? [plotted(result, series, names)] : [];
	if (group) parts.push(group);
	const label = parts.join(" · ");
	return series.comparison ? m.insight_previous_label({ label }) : label;
}

/** What a broken-down chart plots when series labels show only their groups. */
export function plottedTitle(result: QueryResult, names: FormulaNames = {}) {
	const [measure] = result.measures;
	if (calculationsOnly(result))
		return metricLabel(measure.metric, measure.label);
	const [first] = visibleSeries(result);
	if (!first || (result.formulas.length || result.measures.length) > 1)
		return null;
	if (!first.other && !first.group.length && !result.aggregate) return null;
	return plotted(result, first, names);
}

/** The series a reader sees: formulas when present, otherwise the measures. */
export function visibleSeries(result: QueryResult) {
	const formulas = new Set(result.formulas.map((formula) => formula.name));
	return result.series.filter((series) =>
		formulas.size
			? formulas.has(series.measure)
			: !formulas.has(series.measure),
	);
}

/** What a draft charts: its formulas' names or expressions, otherwise its metrics. */
export function plottedNames(
	draft: InsightDraft,
	labels: ReadonlyMap<string, string> = new Map(),
) {
	if (draft.formulas.length)
		return draft.formulas.map(
			(formula) => formula.name?.trim() || formula.expression,
		);
	return [
		...new Set(
			draft.series.flatMap((series) =>
				series.metric
					? [metricLabel(series.metric, labels.get(series.metric))]
					: [],
			),
		),
	];
}
