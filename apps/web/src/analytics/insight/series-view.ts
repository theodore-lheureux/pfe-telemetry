import { combineValues } from "../aggregate";
import type { QueryResult, SeriesResult } from "../contracts";
import { distributionLabels } from "../metric-names";
import type { Display } from "./draft";
import {
	type FormulaNames,
	formatValueDetails,
	groupText,
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
	const formatted = (
		series: SeriesResult | undefined,
		value: number | null,
		minimumFractionDigits = 0,
		bare = false,
	) =>
		formatValueDetails(
			value,
			display,
			series ? seriesSource(result, series) : null,
			locale,
			minimumFractionDigits,
			bare,
		);
	// A count names its subject once: in a title when every series shares it, else by its name.
	const subjectOf = (series: SeriesResult) => {
		const source = seriesSource(result, series);
		return source?.calculation === "count" && display.unit === "auto"
			? distributionLabels(source.metric, source.label).noun
			: null;
	};
	const subjects = new Set(visible.map(subjectOf));
	const [shared] = subjects;
	const subject = subjects.size === 1 ? (shared ?? null) : null;
	return {
		visible,
		current,
		charted,
		color: (series: SeriesResult) => colors.get(identity(series)),
		label: (series: SeriesResult) =>
			seriesLabel(result, series, groupLabel, names),
		groupLabel: (series: SeriesResult) => groupText(series, groupLabel),
		format: (series: SeriesResult | undefined) => (value: number | null) =>
			formatted(series, value).text,
		formatDetails:
			(series: SeriesResult | undefined) =>
			(value: number | null, minimumFractionDigits = 0) =>
				formatted(series, value, minimumFractionDigits),
		/** The subject every value counts, for the results or axis title, if they share one. */
		subject,
		subjectOf,
		/** Axis ticks, without a subject the axis title names. */
		formatShort:
			(series: SeriesResult | undefined) =>
			(value: number | null, minimumFractionDigits = 0) =>
				formatted(series, value, minimumFractionDigits, !!subject),
		/** Table cells, whose subject the title or the series name carries. */
		formatCell:
			(series: SeriesResult) =>
			(value: number | null, minimumFractionDigits = 0) =>
				formatted(series, value, minimumFractionDigits, !!subjectOf(series)),
		empty: !visible.some((series) =>
			series.points.some((point) => point.value !== null),
		),
	};
}
