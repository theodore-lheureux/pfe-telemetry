import { m } from "@recount/i18n/messages";
import { type ChartType, TimeseriesChart } from "../../charts";
import { lineId } from "../series-view";
import type { PanelProps } from "./types";

export function CartesianPanel({
	view,
	pointsOf,
	timeline,
	display,
	bucketSeconds,
	height,
	highlight,
	gapLabel,
	type,
}: PanelProps & { type: ChartType }) {
	const charting = view.visible.filter((series) => view.color(series));
	const points = charting.map(pointsOf);
	const values = points.map((series) =>
		JSON.stringify(series.map((point) => point.value)),
	);
	const series = charting.map((entry, index) => ({
		key: `s${index}`,
		label: view.label(entry),
		color: view.color(entry) ?? "var(--viz-1)",
		format: view.chartFormat(entry),
		comparison: entry.comparison,
		coincident: values.indexOf(values[index]) < index,
		points: points[index],
	}));
	return (
		<TimeseriesChart
			{...timeline}
			label={m.insight_chart_label()}
			series={series}
			bucketSeconds={bucketSeconds}
			format={view.format(view.current[0])}
			axisFormat={view.chartFormat(view.current[0])}
			type={type}
			logScale={display.logScale}
			beginAtZero={display.beginAtZero}
			goal={display.goal}
			height={height}
			className={height}
			legend={display.legend !== undefined}
			legendPosition={display.legend}
			showValues={display.showValues}
			xLabel={display.xLabel}
			yLabel={display.yLabel ?? view.subject ?? undefined}
			yMax={display.yMax}
			smooth={display.lineStyle === "smooth"}
			trend={display.trend}
			movingAverage={display.movingAverage}
			highlight={
				series.find((_, index) => lineId(charting[index]) === highlight)?.key ??
				null
			}
			gapLabel={(key, bucketMs) => {
				const entry = charting[Number(key.slice(1))];
				return entry ? gapLabel(entry, bucketMs) : m.insight_gap_unknown();
			}}
		/>
	);
}
