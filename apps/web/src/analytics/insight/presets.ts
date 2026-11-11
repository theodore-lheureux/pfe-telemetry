import { m } from "@recount/i18n/messages";
import type { MetricDefinition } from "../contracts";
import {
	type DisplayUnit,
	type DraftSeries,
	type InsightDraft,
	SERIES_NAMES,
} from "./draft";

// Usage is derived from raw counters and gauges, so common ones are offered as
// presets that fill in the series, formula and unit.

const CPU = "recount.node.cpu.time";
const MEMORY_TOTAL = "recount.node.memory.total";
const MEMORY_AVAILABLE = "recount.node.memory.available";
const PROCESS_CPU = "process.cpu.time";

export interface Preset {
	id: string;
	name: () => string;
	description: () => string;
	series: DraftSeries[];
	/** Written with the preset's own letters; they are renamed when it is added. */
	formula?: string;
	unit: DisplayUnit;
}

export const PRESETS: Preset[] = [
	{
		id: "cpu-usage",
		name: m.preset_cpu_usage,
		description: m.preset_cpu_usage_description,
		series: [
			{
				name: "A",
				metric: CPU,
				calculation: "rate",
				combine: "sum",
				filters: [
					{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] },
				],
			},
			{
				name: "B",
				metric: CPU,
				calculation: "rate",
				combine: "sum",
				filters: [],
			},
		],
		formula: "A / B * 100",
		unit: "percent",
	},
	{
		id: "memory-usage",
		name: m.preset_memory_usage,
		description: m.preset_memory_usage_description,
		series: [
			{
				name: "A",
				metric: MEMORY_AVAILABLE,
				calculation: "avg",
				combine: "sum",
				filters: [],
			},
			{
				name: "B",
				metric: MEMORY_TOTAL,
				calculation: "avg",
				combine: "sum",
				filters: [],
			},
		],
		formula: "(1 - A / B) * 100",
		unit: "percent",
	},
	{
		id: "process-cpu",
		name: m.preset_process_cpu,
		description: m.preset_process_cpu_description,
		series: [
			{
				name: "A",
				metric: PROCESS_CPU,
				calculation: "rate",
				combine: "sum",
				filters: [],
			},
		],
		unit: "auto",
	},
];

/** Presets whose metrics the project has received. */
export function availablePresets(metrics: MetricDefinition[]) {
	const known = new Set(metrics.map((metric) => metric.name));
	return PRESETS.filter((preset) =>
		preset.series.every((series) => series.metric && known.has(series.metric)),
	);
}

/**
 * Adds a preset from one series row. An empty row is reused and a row a preset added
 * is replaced with its siblings; otherwise the preset is added alongside. Its series
 * take the next free letters and its formula is rewritten to match. Null when there
 * are not enough free letters.
 */
export function applyPreset(
	draft: InsightDraft,
	preset: Preset,
	row: string,
): InsightDraft | null {
	const chosen = draft.series.find((series) => series.name === row);
	const replaced = (entry: { name?: string; source?: string }) =>
		chosen?.source
			? entry.source === chosen.source
			: !chosen?.metric && entry.name === row;
	const series = draft.series.filter((entry) => !replaced(entry));
	const formulas = draft.formulas.filter((formula) => !replaced(formula));
	const used = new Set(series.map((entry) => entry.name));
	const free = SERIES_NAMES.filter((name) => !used.has(name));
	if (free.length < preset.series.length) return null;
	const letters = new Map(
		preset.series.map((entry, index) => [entry.name, free[index]]),
	);
	const source = `${preset.id}:${free[0]}`;
	const added = preset.series.map((entry) => ({
		...entry,
		name: letters.get(entry.name) ?? entry.name,
		source,
	}));
	const charted = series.filter((entry) => entry.metric);
	// Formulas replace series on the chart, so once any exist every chart line is one.
	const needsFormula = preset.formula !== undefined || formulas.length > 0;
	const shown =
		formulas.length || !needsFormula
			? formulas
			: charted.map((entry) => ({ expression: entry.name }));
	return {
		...draft,
		series: [...series, ...added].sort((a, b) => a.name.localeCompare(b.name)),
		formulas: needsFormula
			? [
					...shown,
					{
						expression: (preset.formula ?? "A").replace(
							/\b[A-Z]\b/g,
							(letter) => letters.get(letter) ?? letter,
						),
						name: preset.name(),
						source,
					},
				]
			: formulas,
		display: {
			...draft.display,
			// Mixed units fall back to each value's own formatting.
			unit:
				!charted.length || draft.display.unit === preset.unit
					? preset.unit
					: "auto",
		},
	};
}
