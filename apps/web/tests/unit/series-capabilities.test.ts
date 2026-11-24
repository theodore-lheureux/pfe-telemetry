import { expect, test } from "bun:test";
import {
	capabilities,
	resultCountUnit,
} from "../../src/analytics/capabilities";
import { metricValuesFormatter } from "../../src/analytics/metric-units";

test("series options need no metric name", () => {
	const distribution = capabilities(
		{ behavior: "histogram", unit: "By{process}" },
		[
			{ metric: "custom.measurement", scope: "point", key: "pool", kind: 2 },
			{
				metric: "custom.measurement",
				scope: "resource",
				key: "hidden",
				kind: 2,
				status: "hidden",
			},
		],
	);
	expect(distribution.defaultCalculation).toBe("p95");
	expect(distribution.charts).toContain("heatmap");
	expect(distribution.calculations).toEqual([
		"p50",
		"p75",
		"p90",
		"p95",
		"p99",
		"avg",
		"count",
	]);
	expect(distribution.attributes?.map(({ key }) => key)).toEqual(["pool"]);
	expect(resultCountUnit(distribution.unit, "count")).toBe("processes");
	expect(capabilities({ behavior: "counter" }).calculations).toEqual([
		"rate",
		"increase",
	]);
	expect(capabilities({ behavior: "gauge" }).calculations).toContain("sum");
	expect(capabilities({ behavior: "gauge" }).charts).not.toContain("heatmap");
});

test("an entire visual shares a scale", () => {
	const format = metricValuesFormatter("By/s", [512, 2048], "en");
	expect(format(512, 2).text).toBe("0.50 KiB/s");
	expect(format(2048).text).toBe("2 KiB/s");
});
