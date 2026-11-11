import { m } from "@recount/i18n/messages";
import { formatMeasurement } from "../../activity/format";
import type {
	Calculation,
	Combine,
	Interval,
	QueryResult,
	SeriesResult,
} from "../contracts";
import { metricLabel } from "../metric-names";
import type { DisplayType, DisplayUnit } from "./draft";

export const CALCULATION_LABEL: Record<Calculation, () => string> = {
	last: m.insight_calc_last,
	avg: m.insight_calc_avg,
	min: m.insight_calc_min,
	max: m.insight_calc_max,
	rate: m.insight_calc_rate,
	increase: m.insight_calc_increase,
};
export const COMBINE_LABEL: Record<Combine, () => string> = {
	sum: m.insight_combine_sum,
	avg: m.insight_combine_avg,
	min: m.insight_combine_min,
	max: m.insight_combine_max,
};
/** How sources combine, phrased to read after the calculation: "Rate per second · Sum of all sources". */
export const COMBINE_OPTION_LABEL: Record<Combine, () => string> = {
	sum: m.insight_combine_option_sum,
	avg: m.insight_combine_option_avg,
	min: m.insight_combine_option_min,
	max: m.insight_combine_option_max,
};
export const INTERVAL_LABEL: Record<Interval, () => string> = {
	"10s": m.insight_interval_10s,
	"1m": m.insight_interval_1m,
	"5m": m.insight_interval_5m,
	"15m": m.insight_interval_15m,
	"1h": m.insight_interval_1h,
	"1d": m.insight_interval_1d,
};
export const DISPLAY_LABEL: Record<DisplayType, () => string> = {
	line: m.insight_display_line,
	area: m.insight_display_area,
	bar: m.insight_display_bar,
	stacked: m.insight_display_stacked,
	stat: m.insight_display_stat,
	table: m.insight_display_table,
};
export const UNIT_LABEL: Record<DisplayUnit, () => string> = {
	auto: m.insight_unit_auto,
	percent: m.insight_unit_percent,
	ratio: m.insight_unit_ratio,
	bytes: m.insight_unit_bytes,
	seconds: m.insight_unit_seconds,
};

/**
 * A readable value. With the automatic unit, measures keep their stored unit (rates per
 * second of it) and formulas show plain numbers; a chosen unit applies to everything.
 */
export function formatValue(
	value: number | null,
	unit: DisplayUnit,
	stored: { unit: string; calculation: Calculation } | null,
	locale: string,
) {
	if (value === null) return "—";
	const number = (digits = 3) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(
			value,
		);
	switch (unit) {
		case "percent":
			return `${number(1)} %`;
		case "ratio":
			return new Intl.NumberFormat(locale, {
				style: "percent",
				maximumFractionDigits: 1,
			}).format(value);
		case "bytes":
			return formatMeasurement(value, "By", locale).text;
		case "seconds":
			return formatMeasurement(value, "s", locale).text;
		case "auto":
			break;
	}
	if (!stored) return number();
	if (stored.calculation === "rate") {
		// Seconds per second (such as CPU time) is a plain ratio, roughly busy cores.
		if (stored.unit === "s" || !stored.unit || stored.unit === "1")
			return number();
		return `${number()} ${stored.unit}/s`;
	}
	if (Number.isInteger(value) || stored.unit === "By" || stored.unit === "s")
		return formatMeasurement(value, stored.unit, locale).text;
	return `${number()}${stored.unit && stored.unit !== "1" ? ` ${stored.unit}` : ""}`;
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
	if (alone) return `${alone.name} · ${metricLabel(alone.metric)}`;
	return expression ?? series.measure;
}

function measureText(
	result: QueryResult,
	measure: QueryResult["measures"][number],
) {
	if (result.measures.length > 1)
		return `${measure.name} · ${metricLabel(measure.metric)}`;
	return metricLabel(measure.metric);
}

function groupText(
	series: SeriesResult,
	groupLabel: (value: string | null) => string,
) {
	if (series.other) return m.insight_other();
	if (!series.group.length) return null;
	return series.group.map((value) => groupLabel(value)).join(", ");
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
	const group = groupText(series, groupLabel);
	const parts = !group || shown > 1 ? [plotted(result, series, names)] : [];
	if (group) parts.push(group);
	const label = parts.join(" · ");
	return series.comparison ? m.insight_previous_label({ label }) : label;
}

/** What a broken-down chart plots when series labels show only their groups. */
export function plottedTitle(result: QueryResult, names: FormulaNames = {}) {
	const [first] = visibleSeries(result);
	if (!first || (result.formulas.length || result.measures.length) > 1)
		return null;
	if (!first.other && !first.group.length) return null;
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
