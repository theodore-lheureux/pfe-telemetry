import { expect, test } from "bun:test";
import {
	histogramFormatter,
	histogramQuantile,
	visibleHistogramBuckets,
} from "../../src/analytics/histograms";

test("ratio heatmaps keep zero to 100% and only extend when occupied", () => {
	const metric = "recount.node.process.cpu.utilization.distribution";
	const bounds = [0, 0.1, 0.5, 1, 2, 4];
	const row = {
		bucket: "0",
		bounds,
		counts: ["1", "2", "0", "0", "0", "0", "0"],
	};
	expect(visibleHistogramBuckets([row], "1", metric)).toEqual({
		first: 0,
		last: 3,
	});
	expect(
		visibleHistogramBuckets(
			[{ ...row, counts: ["1", "2", "0", "0", "1", "0", "0"] }],
			"1",
			metric,
		),
	).toEqual({ first: 0, last: 4 });
	expect(visibleHistogramBuckets([row], "By", "")).toEqual({
		first: 0,
		last: 2,
	});
});

test("percentiles pool counts before interpolation and respect overflow bounds", () => {
	const layouts = [
		{ bounds: [0, 10, 20], counts: ["0", "1", "1", "0"] },
		{ bounds: [0, 5, 10, 20], counts: ["0", "40", "58", "0", "0"] },
	];
	expect(histogramQuantile(layouts, 0.5)).toBeCloseTo(500 / 99);
	expect(
		histogramQuantile([{ bounds: [10, 20], counts: ["0", "1", "99"] }], 0.99),
	).toBe(20);
	expect(
		histogramQuantile([{ bounds: [1], counts: ["0", "0"] }], 0.5),
	).toBeNull();
});

test("histogram labels localize percentages and scale duration and byte bounds", () => {
	const metric = "recount.node.process.cpu.utilization.distribution";
	expect(histogramFormatter("1", metric, "en").range([0.01, 0.05], 1)).toBe(
		"1–5 %",
	);
	expect(histogramFormatter("1", metric, "fr").value(0.015)).toBe("1,5 %");
	expect(histogramFormatter("s", "", "en").value(0.005)).toBe("5 ms");
	expect(
		histogramFormatter("By", "", "en", 2 ** 20).range([2 ** 19, 2 ** 20], 1),
	).toBe("0.5–1 MiB");
});
