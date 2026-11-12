import { combineValues } from "../aggregate";
import type { QueryResult, SeriesResult } from "../contracts";
import type { Display } from "./draft";
import {
	type FormulaNames,
	formatValue,
	seriesLabel,
	seriesSource,
	visibleSeries,
} from "./labels";

// Categorical colors go in fixed order; series past the eighth stay in the table only.
export const CHART_SERIES = 8;

export function identity(series: SeriesResult) {
	return JSON.stringify([series.measure, series.group, series.other ?? false]);
}

/** Identifies one visible line: a series and whether it is the comparison. */
export function lineId(series: SeriesResult) {
	return `${identity(series)}/${series.comparison ?? false}`;
}

export function stats(series: SeriesResult) {
	const values = series.points
		.map((point) => point.value)
		.filter((value): value is number => value !== null);
	return {
		latest: values.at(-1) ?? null,
		average: combineValues(values, "avg"),
		min: combineValues(values, "min"),
		max: combineValues(values, "max"),
		p95: combineValues(values, "p95"),
		p99: combineValues(values, "p99"),
	};
}

export type SeriesView = ReturnType<typeof seriesView>;

/**
 * What the chart and the table show for a result: the visible series, a color for each
 * charted one (comparisons share their current series' color), labels and formatting.
 */
export function seriesView(
	result: QueryResult,
	display: Display,
	groupLabel: (value: string | null) => string,
	names: FormulaNames,
	locale: string,
) {
	const visible = visibleSeries(result);
	const current = visible.filter((series) => !series.comparison);
	const charted = current.slice(0, CHART_SERIES);
	const colors = new Map(
		charted.map((series, index) => [
			identity(series),
			`var(--viz-${index + 1})`,
		]),
	);
	return {
		visible,
		current,
		charted,
		color: (series: SeriesResult) => colors.get(identity(series)),
		label: (series: SeriesResult) =>
			seriesLabel(result, series, groupLabel, names),
		format: (series: SeriesResult | undefined) => (value: number | null) =>
			formatValue(
				value,
				display.unit,
				series ? seriesSource(result, series) : null,
				locale,
			),
		empty: !visible.some((series) =>
			series.points.some((point) => point.value !== null),
		),
	};
}
