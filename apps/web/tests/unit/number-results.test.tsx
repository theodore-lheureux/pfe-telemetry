import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryResult } from "../../src/analytics/contracts";
import { DEFAULT_DISPLAY } from "../../src/analytics/insight/draft";
import {
	NumberResults,
	numberComparison,
} from "../../src/analytics/insight/number-results";
import { seriesView } from "../../src/analytics/insight/series-view";

test("number comparisons handle missing, zero and negative baselines", () => {
	expect(numberComparison(80, 100)).toBe(-0.2);
	expect(numberComparison(0, 100)).toBe(-1);
	expect(numberComparison(-80, -100)).toBe(0.2);
	expect(numberComparison(80, 0)).toBeNull();
	expect(numberComparison(null, 100)).toBeNull();
	expect(numberComparison(80, null)).toBeNull();
});

test("Number results show a current headline and its comparison, not a second number card", () => {
	const result: QueryResult = {
		shape: "timeseries",
		from: new Date(0),
		to: new Date(60_000),
		bucketSeconds: 60,
		groupBy: [],
		measures: [
			{ name: "A", metric: "custom.metric", unit: "", calculation: "last" },
		],
		formulas: [],
		series: [
			{ measure: "A", group: [], points: [{ bucketMs: 0, value: 80 }] },
			{ measure: "B", group: [], points: [{ bucketMs: 0, value: 200 }] },
			{
				measure: "A",
				group: [],
				comparison: true,
				points: [{ bucketMs: 0, value: 100 }],
			},
		],
		limited: false,
		compared: { from: new Date(-60_000), to: new Date(0) },
		coverage: null,
		ingestedThrough: null,
	};
	const display = {
		...DEFAULT_DISPLAY,
		type: "stat" as const,
		numberChart: "none" as const,
	};
	const view = seriesView(result, display, (value) => value ?? "—", {}, "en");
	for (const compact of [true, false]) {
		const html = renderToStaticMarkup(
			<NumberResults
				view={view}
				display={display}
				pointsOf={() => []}
				bucketSeconds={60}
				compact={compact}
				height="h-72"
			/>,
		);
		expect(html).toContain(">80</span>");
		expect(html).not.toContain(">200</span>");
		expect(html).toContain("vs. 100 prior");
		expect(html).toContain("-20%");
		expect(html).not.toContain("recharts");
		const noComparison = renderToStaticMarkup(
			<NumberResults
				view={{
					...view,
					visible: view.visible.filter((series) => !series.comparison),
				}}
				display={display}
				pointsOf={() => []}
				bucketSeconds={60}
				compact={compact}
				height="h-72"
			/>,
		);
		expect(noComparison.slice(0, noComparison.indexOf(">"))).toContain(
			"items-center justify-center",
		);
	}
});
