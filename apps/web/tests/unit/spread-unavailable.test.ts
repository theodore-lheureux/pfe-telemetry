import { expect, test } from "bun:test";
import { spreadUnavailable } from "../../src/analytics/insight/display-options";
import { DEFAULT_DRAFT, newSeries } from "../../src/analytics/insight/draft";

test("a range across sources needs a series that neither adds sources up nor feeds a formula", () => {
	const summed = { ...newSeries("A"), combine: "sum" as const };
	const averaged = { ...newSeries("B"), combine: "avg" as const };
	expect(spreadUnavailable({ ...DEFAULT_DRAFT, series: [summed] })).toContain(
		"adds its sources up",
	);
	expect(
		spreadUnavailable({
			...DEFAULT_DRAFT,
			series: [averaged],
			formulas: [{ expression: "B * 100" }],
		}),
	).toContain("formula");
	expect(
		spreadUnavailable({ ...DEFAULT_DRAFT, series: [summed, averaged] }),
	).toBeNull();
	// Combined groups band across the groups instead, formula or not.
	expect(
		spreadUnavailable({
			...DEFAULT_DRAFT,
			series: [summed],
			formulas: [{ expression: "A * 100" }],
			groupBy: "node",
			aggregate: "avg",
		}),
	).toBeNull();
});
