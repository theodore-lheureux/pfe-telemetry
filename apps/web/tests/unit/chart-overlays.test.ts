import { expect, test } from "bun:test";
import {
	movingAveragePoints,
	trendPoints,
} from "../../src/analytics/chart-overlays";

const points = [
	{ bucketMs: 0, value: 1 },
	{ bucketMs: 1, value: null },
	{ bucketMs: 2, value: 3 },
	{ bucketMs: 3, value: 5 },
];

test("a trend is the least-squares line through the known values, at every bucket", () => {
	const trend = trendPoints(points);
	expect(trend.map((point) => point.bucketMs)).toEqual([0, 1, 2, 3]);
	expect(trend.map((point) => Number(point.value?.toFixed(3)))).toEqual([
		0.857, 2.143, 3.429, 4.714,
	]);
	expect(trendPoints([{ bucketMs: 0, value: 1 }])).toEqual([]);
	// Empty buckets before the first value get no trend.
	expect(
		trendPoints([{ bucketMs: -1, value: null }, ...points])[0]?.value,
	).toBeNull();
});

test("a moving average skips empty buckets in its trailing window", () => {
	expect(movingAveragePoints(points, 2).map((point) => point.value)).toEqual([
		1, 1, 3, 4,
	]);
	expect(
		movingAveragePoints([{ bucketMs: 0, value: null }], 3)[0]?.value,
	).toBeNull();
});
