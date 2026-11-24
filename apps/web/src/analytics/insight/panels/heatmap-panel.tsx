import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { IconEmptyState } from "../../../components/workspace";
import { cn } from "../../../lib/utils";
import type { QueryResult, SeriesResult } from "../../contracts";
import { omissionName } from "../../coverage";
import { metricLabel } from "../../definition-labels";
import { histogramLabels } from "../../histogram-labels";
import {
	approximateCount,
	countText,
	metricValuesFormatter,
	ratioScale,
} from "../../metric-units";
import { calculationLabel, formatValue, seriesSource } from "../labels";
import { lineId } from "../series-view";
import type { PanelProps } from "./types";

export function heatmapTitle(result: QueryResult) {
	return [
		...new Set(
			result.measures
				.filter(({ name }) =>
					result.series.some(
						(series) => series.measure === name && series.bounds,
					),
				)
				.map(({ metric, label }) => metricLabel(metric, label)),
		),
	].join(", ");
}

function heatmapOf(
	measure: QueryResult["measures"][number],
	series: SeriesResult,
	omitted?: SeriesResult,
) {
	return {
		bounds: series.bounds ?? [],
		columns: series.points.flatMap(({ bucketMs, counts }) =>
			bucketMs === null || !counts ? [] : [{ bucketMs, counts }],
		),
		...histogramLabels(
			measure.presentation?.quantity,
			metricLabel(measure.metric, measure.label),
		),
		subject: calculationLabel("count", measure.unit),
		count: (value: number, locale: string) =>
			countText(
				measure.unit,
				approximateCount(value, locale),
				Math.round(value),
				locale,
			),
		scale: ratioScale(measure.unit),
		idle:
			omitted &&
			new Map(omitted.points.map(({ bucketMs, value }) => [bucketMs, value])),
	};
}

export function HeatmapPanel({
	result,
	view,
	fill,
	height,
	display,
	emptyDetail,
	timeline,
}: PanelProps) {
	const heatmaps = view.current.filter((series) => series.bounds);
	const omittedOf = (series: SeriesResult) =>
		result.series.find(
			(other) =>
				other.measure === omissionName(series.measure) &&
				JSON.stringify(other.group) === JSON.stringify(series.group),
		);
	if (
		!heatmaps.some((series) =>
			series.points.some(({ counts }) => counts?.some((count) => count > 0)),
		)
	) {
		const omitted = heatmaps.some((series) =>
			omittedOf(series)?.points.some(({ value }) => value),
		);
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.insight_empty_result()}
				description={omitted ? m.insight_all_idle() : emptyDetail}
				className={height}
			/>
		);
	}
	const multiple = new Set(heatmaps.map((series) => series.measure)).size > 1;
	return (
		<div
			className={cn("flex flex-col gap-4", fill && "h-full overflow-y-auto")}
		>
			{heatmaps.map((series) => {
				const measure = seriesSource(result, series);
				if (!measure) return null;
				const locale = getLocale();
				const auto = metricValuesFormatter(
					measure.unit,
					series.bounds ?? [],
					locale,
				);
				const format = (value: number) =>
					display.unit === "auto"
						? auto(value).text
						: formatValue(value, display, null, locale);
				const title = [
					multiple && metricLabel(measure.metric, measure.label),
					view.groupLabel(series),
				]
					.filter(Boolean)
					.join(" · ");
				return (
					<section
						key={lineId(series)}
						className={cn("flex flex-col gap-1", fill && "min-h-56 flex-1")}
					>
						{title && <h3 className="text-sm font-medium">{title}</h3>}
						{timeline([], {
							...heatmapOf(measure, series, omittedOf(series)),
							format,
						})}
					</section>
				);
			})}
		</div>
	);
}
