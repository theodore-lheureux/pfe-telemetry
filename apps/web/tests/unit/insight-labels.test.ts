import { expect, test } from "bun:test";
import type { QueryResult, SeriesResult } from "../../src/analytics/contracts";
import type { Display } from "../../src/analytics/insight/draft";
import {
	formatValue,
	plottedTitle,
	seriesLabel,
} from "../../src/analytics/insight/labels";
import {
	approximateCount,
	distributionLabels,
} from "../../src/analytics/metric-names";

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

test("values name what they count without UCUM annotations and keep small magnitudes", () => {
	const stored = (unit: string) => ({ unit, calculation: "avg" as const });
	const auto = { unit: "auto" as const };
	expect(formatValue(30, auto, stored("{process}"), "en")).toBe("30");
	expect(formatValue(0.0015, auto, stored("{process}"), "en")).toBe("0.0015");
	expect(formatValue(0.55, auto, stored("ms"), "en")).toBe("0.55 ms");
});

test("a chosen unit formats every value, including custom text around it", () => {
	const as = (unit: Display["unit"], unitAffix?: string) => ({
		unit,
		unitAffix,
	});
	expect(formatValue(1500, as("short"), null, "en")).toBe("1.5K");
	expect(formatValue(12.5, as("currency"), null, "en")).toBe("$12.50");
	expect(formatValue(42, as("prefix", "~"), null, "en")).toBe("~42");
	expect(formatValue(42, as("postfix", " req"), null, "en")).toBe("42 req");
});

test("per-scan process counts round to whole processes and mark the rounding", () => {
	const cpu = distributionLabels(
		"recount.node.process.cpu.utilization.distribution",
	);
	expect(String(cpu.count(24, "en"))).toBe("24 busy processes");
	expect(String(cpu.count(23.6, "en"))).toBe("≈24 busy processes");
	expect(String(cpu.count(1.2, "en"))).toBe("≈1 busy process");
	expect(approximateCount(1234.4, "fr")).toMatch(/^≈1\s234$/u);
});

test("a count of observations reads as subjects, not in the metric's unit", () => {
	const auto = { unit: "auto" as const };
	const stored = {
		unit: "1",
		calculation: "count" as const,
		metric: "recount.node.process.cpu.utilization.distribution",
	};
	expect(formatValue(2.17, auto, stored, "en")).toBe("2.2 busy processes");
	expect(formatValue(1, auto, stored, "en")).toBe("1 busy process");
	expect(formatValue(0.5, auto, { ...stored, calculation: "p95" }, "en")).toBe(
		"50%",
	);
});
