import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { QueryResult, SeriesResult } from "../../contracts";
import { metricLabel } from "../../definition-labels";
import { histogramLabels } from "../../histogram-labels";
import {
	approximateCount,
	countText,
	metricValuesFormatter,
	ratioScale,
} from "../../metric-units";
import type { Display } from "../draft";
import { calculationLabel, formatValue, seriesSource } from "../labels";

export function heatmapTitle(result: QueryResult) {
	const displayed = new Set(
		result.series
			.filter((series) => series.bounds)
			.map(({ measure }) => measure),
	);
	return [
		...new Set(
			result.measures
				.filter(({ name }) => displayed.has(name))
				.map(({ metric, label }) => metricLabel(metric, label)),
		),
	].join(", ");
}

export function heatmapEmptyDetail(result: QueryResult, fallback?: string) {
	const omitted = result.omissions?.find((series) =>
		series.points.some(({ value }) => (value ?? 0) > 0),
	);
	if (!omitted) return fallback;
	const reason = seriesSource(result, omitted)?.presentation?.coverage?.reason;
	return reason === "idle"
		? m.insight_all_idle()
		: m.metric_coverage_all_omitted();
}

export function heatmapData(
	result: QueryResult,
	series: SeriesResult,
	display: Display,
) {
	const measure = seriesSource(result, series);
	if (!measure || !series.bounds) return null;
	const { unit, presentation } = measure;
	const label = metricLabel(measure.metric, measure.label);
	const locale = getLocale();
	const auto = metricValuesFormatter(unit, series.bounds, locale);
	const group = JSON.stringify(series.group);
	const omissions = result.omissions?.find(
		(other) =>
			other.measure === series.measure && JSON.stringify(other.group) === group,
	);
	return {
		label,
		bounds: series.bounds,
		columns: series.points.flatMap(({ bucketMs, counts }) =>
			bucketMs === null || !counts ? [] : [{ bucketMs, counts }],
		),
		...histogramLabels(presentation?.quantity, label),
		subject: calculationLabel("count", unit),
		count: (value: number) =>
			countText(
				unit,
				approximateCount(value, locale),
				Math.round(value),
				locale,
			),
		scale: ratioScale(unit),
		omissionReason: presentation?.coverage?.reason,
		omitted:
			omissions &&
			new Map(omissions.points.map(({ bucketMs, value }) => [bucketMs, value])),
		format: (value: number) =>
			display.unit === "auto"
				? auto(value).text
				: formatValue(value, display, null, locale),
	};
}
