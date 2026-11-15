import type { ChartPoint } from "./charts";

// Lines drawn over a series to read its direction: a least-squares trend and a
// trailing moving average. Both skip empty buckets and a bucket still filling.

/**
 * The least-squares line through the points with values, from the first value to the
 * last; it does not extend over empty buckets, where it would only extrapolate.
 */
export function trendPoints(points: ChartPoint[]): ChartPoint[] {
	const known = points.filter(
		(point): point is { bucketMs: number; value: number } =>
			point.value !== null,
	);
	if (known.length < 2) return [];
	const count = known.length;
	const meanX = known.reduce((sum, point) => sum + point.bucketMs, 0) / count;
	const meanY = known.reduce((sum, point) => sum + point.value, 0) / count;
	let spread = 0,
		covariance = 0;
	for (const point of known) {
		spread += (point.bucketMs - meanX) ** 2;
		covariance += (point.bucketMs - meanX) * (point.value - meanY);
	}
	const slope = spread ? covariance / spread : 0;
	const first = known[0]?.bucketMs ?? 0,
		last = known.at(-1)?.bucketMs ?? 0;
	return points.map((point) => ({
		bucketMs: point.bucketMs,
		value:
			point.bucketMs < first || point.bucketMs > last
				? null
				: meanY + slope * (point.bucketMs - meanX),
	}));
}

/** The mean of the values among the last `window` buckets, ending at each bucket. */
export function movingAveragePoints(
	points: ChartPoint[],
	window: number,
): ChartPoint[] {
	return points.map((point, index) => {
		const values = points
			.slice(Math.max(0, index - window + 1), index + 1)
			.flatMap((entry) => (entry.value === null ? [] : [entry.value]));
		return {
			bucketMs: point.bucketMs,
			value: values.length
				? values.reduce((sum, value) => sum + value, 0) / values.length
				: null,
		};
	});
}
