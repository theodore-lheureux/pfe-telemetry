import { expect, test } from "bun:test";
import {
	applyDashboardFilters,
	decodeDashboardFilters,
	encodeDashboardFilters,
	parseTileOverrides,
	tileDraft,
} from "../../src/analytics/dashboard-filters";
import {
	DEFAULT_DRAFT,
	type InsightDraft,
} from "../../src/analytics/insight/draft";

const insight: InsightDraft = {
	...DEFAULT_DRAFT,
	filters: [{ field: "host", op: "eq", values: ["a"] }],
	groupBy: "node",
	aggregate: "p95",
	compare: { previous: true },
};

test("dashboard overrides replace or extend each insight's settings", () => {
	const shown = applyDashboardFilters(insight, {
		range: { kind: "last", count: 7, unit: "days" },
		interval: "1h",
		filters: [{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] }],
		breakdown: "host",
		compare: null,
	});
	expect(shown.range).toEqual({ kind: "last", count: 7, unit: "days" });
	expect(shown.interval).toBe("1h");
	// Dashboard filters are added to the insight's own.
	expect(shown.filters).toHaveLength(2);
	// A new grouping drops the insight's collapse of its own grouping.
	expect(shown.groupBy).toBe("host");
	expect(shown.aggregate).toBeUndefined();
	expect(shown.compare).toBeUndefined();
});

test("absent overrides keep each insight's settings, and no grouping removes it", () => {
	expect(applyDashboardFilters(insight, {})).toEqual(insight);
	const ungrouped = applyDashboardFilters(insight, { breakdown: "" });
	expect(ungrouped.groupBy).toBeUndefined();
	expect(ungrouped.compare).toEqual({ previous: true });
});

test("overrides from a URL are validated and written in one order", () => {
	expect(decodeDashboardFilters('{"interval":"2m"}')).toBeNull();
	expect(decodeDashboardFilters('{"breakdown":"password"}')).toBeNull();
	expect(decodeDashboardFilters("not json")).toBeNull();
	expect(
		encodeDashboardFilters({
			compare: null,
			interval: "5m",
			breakdown: "node",
		}),
	).toBe('{"interval":"5m","breakdown":"node","compare":null}');
});

test("a tile's overrides apply over the dashboard's, or alone when it ignores them", () => {
	const dashboard = { interval: "5m" as const, breakdown: "host" };
	const shown = tileDraft(insight, dashboard, { interval: "1h" });
	expect(shown.interval).toBe("1h");
	expect(shown.groupBy).toBe("host");
	const alone = tileDraft(insight, dashboard, { ignoreDashboard: true });
	expect(alone.interval).toBe(insight.interval);
	expect(alone.groupBy).toBe("node");
	expect(() => parseTileOverrides({ ignoreDashboard: 1 })).toThrow();
});

test("a tile can drop the dashboard's filters on chosen fields and keep its range", () => {
	const dashboard = {
		range: { kind: "last" as const, count: 7, unit: "days" as const },
		filters: [
			{ field: "execution", op: "eq" as const, values: ["slurm:1"] },
			{ field: "host", op: "eq" as const, values: ["b"] },
		],
	};
	const context = tileDraft(insight, dashboard, {
		ignoreFilters: ["execution"],
	});
	expect(context.range).toEqual(dashboard.range);
	expect(context.filters).toEqual([
		...insight.filters,
		{ field: "host", op: "eq", values: ["b"] },
	]);
	expect(tileDraft(insight, dashboard, {}).filters).toHaveLength(3);
	expect(parseTileOverrides({ ignoreFilters: ["execution"] })).toEqual({
		ignoreFilters: ["execution"],
	});
	for (const ignoreFilters of [
		[],
		["execution", "execution"],
		["no such field"],
		"execution",
	])
		expect(() => parseTileOverrides({ ignoreFilters })).toThrow();
});
