import { expect, test } from "bun:test";
import type { QueryResult, SeriesResult } from "../../src/analytics/contracts";
import { plottedTitle, seriesLabel } from "../../src/analytics/insight/labels";

const measure = (name: string) => ({
	name,
	metric: "recount.node.memory.total",
	unit: "By",
	calculation: "avg",
});
const series = (measure: string, group: string[], comparison = false) =>
	({
		measure,
		group,
		other: false,
		comparison,
		points: [],
	}) as unknown as SeriesResult;
const result = (formulas: string[]) =>
	({
		measures: [measure("A"), measure("B")],
		formulas: formulas.map((name) => ({
			name,
			expression: "(A - B) / A * 100",
		})),
	}) as unknown as QueryResult;
const label = (value: string | null) => value ?? "—";

test("a broken-down formula is named by its group alone", () => {
	expect(seriesLabel(result(["F"]), series("F", ["node-1"]), label)).toBe(
		"node-1",
	);
	expect(
		seriesLabel(result(["F"]), series("F", ["node-1"], true), label),
	).toContain("node-1");
});

test("an ungrouped formula and several measures keep what they plot", () => {
	expect(seriesLabel(result(["F"]), series("F", []), label)).toBe(
		"(A - B) / A * 100",
	);
	expect(seriesLabel(result([]), series("A", ["node-1"]), label)).toBe(
		"A · Node memory total · node-1",
	);
});

test("a formula name replaces its expression and titles a broken-down chart", () => {
	expect(
		seriesLabel(result(["F"]), series("F", []), label, { F: "Memory usage" }),
	).toBe("Memory usage");
	const grouped = {
		...result(["F"]),
		series: [series("F", ["node-1"])],
	} as QueryResult;
	expect(plottedTitle(grouped, { F: "Memory usage" })).toBe("Memory usage");
	expect(plottedTitle(grouped)).toBe("(A - B) / A * 100");
	expect(
		plottedTitle(
			{ ...grouped, series: [series("F", [])] },
			{ F: "Memory usage" },
		),
	).toBeNull();
});

test("a formula of one series reads as that series", () => {
	const single = {
		...result(["F"]),
		formulas: [{ name: "F", expression: "B" }],
	} as QueryResult;
	expect(seriesLabel(single, series("F", []), label)).toBe(
		"B · Node memory total",
	);
});
