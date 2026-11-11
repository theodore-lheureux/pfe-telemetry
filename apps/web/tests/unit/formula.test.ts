import { expect, test } from "bun:test";
import {
	evaluateFormula,
	FormulaError,
	parseFormula,
} from "../../src/analytics/formula";

const run = (text: string, values: Record<string, number | null>) =>
	evaluateFormula(
		parseFormula(text, Object.keys(values)),
		(name) => values[name] ?? null,
	);

test("formulas follow arithmetic precedence and keep gaps as gaps", () => {
	expect(run("(1 - idle / total) * 100", { idle: 3, total: 4 })).toBe(25);
	expect(run("a + b * 2 - -c", { a: 1, b: 2, c: 3 })).toBe(8);
	expect(run("a / b", { a: 1, b: 0 })).toBeNull();
	expect(run("a + b", { a: 1, b: null })).toBeNull();
});

test("formulas reject unknown series, code and malformed input", () => {
	for (const text of [
		"a + b",
		"a; b",
		"a(1)",
		"process.exit()",
		"(a",
		"a +",
		"",
		"a ** 2",
	])
		expect(() => parseFormula(text, ["a"])).toThrow(FormulaError);
	expect(() =>
		parseFormula(`${"(".repeat(40)}a${")".repeat(40)}`, ["a"]),
	).toThrow(FormulaError);
});
