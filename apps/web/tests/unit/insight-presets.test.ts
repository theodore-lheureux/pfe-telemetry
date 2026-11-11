import { expect, test } from "bun:test";
import type { MetricDefinition } from "../../src/analytics/contracts";
import {
	DEFAULT_DRAFT,
	type InsightDraft,
	removeSeries,
	toQuery,
} from "../../src/analytics/insight/draft";
import {
	applyPreset,
	availablePresets,
	PRESETS,
} from "../../src/analytics/insight/presets";

const metric = (name: string) => ({ name }) as MetricDefinition;
const preset = (id: string) => {
	const found = PRESETS.find((entry) => entry.id === id);
	if (!found) throw new Error(`missing preset ${id}`);
	return found;
};
const apply = (draft: InsightDraft, id: string, row: string) => {
	const next = applyPreset(draft, preset(id), row);
	if (!next) throw new Error("expected the preset to fit");
	return next;
};

test("offers only presets whose metrics the project has", () => {
	const ids = availablePresets([metric("recount.node.cpu.time")]).map(
		(entry) => entry.id,
	);
	expect(ids).toEqual(["cpu-usage"]);
});

test("presets fill an empty row, then add alongside with their own letters", () => {
	const memory = apply(
		{ ...DEFAULT_DRAFT, groupBy: "node" },
		"memory-usage",
		"A",
	);
	expect(memory.groupBy).toBe("node");
	expect(memory.display.unit).toBe("percent");
	expect(memory.series.map((series) => series.name)).toEqual(["A", "B"]);
	// Choosing CPU usage from a new, empty row C keeps memory usage.
	const both = apply(
		{
			...memory,
			series: [
				...memory.series,
				{
					...memory.series[0],
					name: "C",
					metric: undefined,
					source: undefined,
				},
			],
		},
		"cpu-usage",
		"C",
	);
	expect(both.series.map((series) => series.name)).toEqual([
		"A",
		"B",
		"C",
		"D",
	]);
	expect(
		both.formulas.map(({ expression, name }) => ({ expression, name })),
	).toEqual([
		{ expression: "(1 - A / B) * 100", name: "Memory usage" },
		{ expression: "C / D * 100", name: "CPU usage" },
	]);
	const query = toQuery(both, new Date("2026-11-11T12:00:00Z"), "UTC", "en");
	expect(query?.formulas?.map((formula) => formula.name)).toEqual(["F1", "F2"]);
	// Choosing again from one of its rows replaces only that calculated metric.
	const swapped = apply(both, "memory-usage", "C");
	expect(swapped.formulas.map((formula) => formula.name)).toEqual([
		"Memory usage",
		"Memory usage",
	]);
	expect(swapped.series).toHaveLength(4);
	// Removing one of its series removes the calculated metric as a whole.
	expect(
		removeSeries(both, "D").formulas.map((formula) => formula.name),
	).toEqual(["Memory usage"]);
});

test("a preset added next to plain series keeps them charted as formulas", () => {
	const draft: InsightDraft = {
		...DEFAULT_DRAFT,
		series: [{ ...DEFAULT_DRAFT.series[0], metric: "process.cpu.time" }],
		display: { ...DEFAULT_DRAFT.display, unit: "bytes" },
	};
	const next = apply(draft, "memory-usage", "A");
	expect(next.series.map((series) => series.name)).toEqual(["A", "B", "C"]);
	expect(next.formulas.map((formula) => formula.expression)).toEqual([
		"A",
		"(1 - B / C) * 100",
	]);
	// Different units fall back to each value's own formatting.
	expect(next.display.unit).toBe("auto");
});

test("a preset that needs more free letters than remain does not fit", () => {
	const full: InsightDraft = {
		...DEFAULT_DRAFT,
		series: Array.from({ length: 25 }, (_, index) => ({
			...DEFAULT_DRAFT.series[0],
			name: String.fromCharCode(65 + index),
			metric: "process.cpu.time",
		})),
	};
	expect(applyPreset(full, preset("cpu-usage"), "A")).toBeNull();
	expect(applyPreset(full, preset("process-cpu"), "A")).not.toBeNull();
});
