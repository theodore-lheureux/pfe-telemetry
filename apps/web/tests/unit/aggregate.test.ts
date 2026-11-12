import { expect, test } from "bun:test";
import {
	aggregateGroups,
	combineValues,
	percentile,
} from "../../src/analytics/aggregate";
import { parseQuery } from "../../src/analytics/validation";
import { InputError } from "../../src/lib/input-error";

test("percentiles are exact nearest ranks, matching ClickHouse quantileExact", () => {
	expect(percentile([30, 10, 100, 20], 0.5)).toBe(30);
	expect(percentile([30, 10, 100, 20], 0.95)).toBe(100);
	expect(percentile([5], 0.99)).toBe(5);
	expect(percentile([], 0.5)).toBeNull();
	expect(combineValues([1, 2, 3], "count")).toBe(3);
	expect(combineValues([], "sum")).toBeNull();
});

test("groups collapse per measure, window and bucket", () => {
	const point = (bucketMs: number, value: number | null) => ({
		bucketMs,
		value,
	});
	const collapsed = aggregateGroups(
		[
			{ measure: "F", group: ["a"], points: [point(0, 10), point(60, 30)] },
			{ measure: "F", group: ["b"], points: [point(0, 20), point(60, null)] },
			{
				measure: "F",
				group: ["a"],
				comparison: true,
				points: [point(0, 1)],
			},
		],
		"max",
	);
	expect(collapsed).toEqual([
		{
			measure: "F",
			group: [],
			points: [point(0, 20), point(60, 30)],
		},
		{ measure: "F", group: [], comparison: true, points: [point(0, 1)] },
	]);
});

test("aggregating groups needs a breakdown and a known operation", () => {
	const base = {
		shape: "timeseries",
		range: { last: "1h" },
		interval: "1m",
		measures: [
			{
				name: "A",
				metric: "recount.node.cpu.time",
				calculation: "rate",
				combine: "sum",
			},
		],
	};
	expect(
		parseQuery({ ...base, groupBy: ["node"], aggregate: "p99" }).aggregate,
	).toBe("p99");
	expect(() => parseQuery({ ...base, aggregate: "p99" })).toThrow(InputError);
	expect(() =>
		parseQuery({ ...base, groupBy: ["node"], aggregate: "p42" }),
	).toThrow(InputError);
});
