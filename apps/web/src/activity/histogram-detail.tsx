import { HistogramHeatmap } from "../analytics/insight/histogram-heatmap";
import { useDisplayTimeZone } from "../components/time-display";
import type { PointDetail } from "./contracts";

export function HistogramDetail({
	measurement,
}: Pick<PointDetail, "measurement">) {
	const zone = useDisplayTimeZone();
	const {
		bucket_counts,
		explicit_bounds,
		count,
		sum,
		min,
		max,
		unit,
		time_unix_milli,
	} = measurement;
	if (
		measurement.metric_kind !== 3 ||
		!Array.isArray(bucket_counts) ||
		!Array.isArray(explicit_bounds) ||
		bucket_counts.length !== explicit_bounds.length + 1
	)
		return null;
	return (
		<HistogramHeatmap
			zone={zone}
			unit={typeof unit === "string" ? unit : ""}
			limited={false}
			rows={[
				{
					bucket: String(time_unix_milli),
					bounds: explicit_bounds.map(Number),
					counts: bucket_counts.map(String),
					count: String(count ?? 0),
					mean:
						typeof sum === "number" && Number(count) > 0
							? sum / Number(count)
							: null,
					min: typeof min === "number" ? min : null,
					max: typeof max === "number" ? max : null,
				},
			]}
		/>
	);
}
