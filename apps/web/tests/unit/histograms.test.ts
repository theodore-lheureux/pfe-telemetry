import { expect, test } from "bun:test";
import {
	histogramFormatter,
	histogramQuantile,
} from "../../src/analytics/histograms";

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
