import { expect, test } from "bun:test";
import type { QueryResult } from "../../src/analytics/contracts";
import { thinPercentiles } from "../../src/analytics/insight/percentile-warning";

function result(percentiles: { level: number; values: number }[]) {
	return {
		series: percentiles.map((percentile, index) => ({
			measure: `m${index}`,
			group: [],
			percentile,
			points: [],
		})),
	} as unknown as QueryResult;
}

test("percentiles over too few values to differ from the largest are flagged", () => {
	expect(
		thinPercentiles(
			result([
				{ level: 0.95, values: 4 },
				{ level: 0.95, values: 7 },
				{ level: 0.99, values: 100 },
				{ level: 0.5, values: 1 },
			]),
		),
	).toEqual([{ label: "p95", values: 7, needed: 20 }]);
	expect(thinPercentiles(result([{ level: 0.9, values: 10 }]))).toEqual([]);
	expect(thinPercentiles(result([{ level: 0.99, values: 99 }]))).toEqual([
		{ label: "p99", values: 99, needed: 100 },
	]);
});
