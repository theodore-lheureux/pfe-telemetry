import { m } from "@recount/i18n/messages";
import preset from "../../presets/collector-metrics.json" with { type: "json" };
import { InputError } from "../lib/input-error";
import type { ProjectReference } from "../organizations/contracts";
import type { Measure, MetricDefinition } from "./contracts";
import { formulaMeasures, parseFormula } from "./formula";
import { ALLOWED_CALCULATIONS, parseQuery } from "./validation";

export const CALCULATED_PREFIX = "recount.calculated.";
export const MAX_CALCULATED_INPUTS = 8;
export const CALCULATED_UNITS = ["1", "%", "By", "s"] as const;
export type CalculatedUnit = (typeof CALCULATED_UNITS)[number];
export interface CalculationDefinition {
	inputs: Measure[];
	expression: string;
	unit: CalculatedUnit;
}
export interface CalculatedMetric extends CalculationDefinition {
	id: string;
	name: string;
	description: string;
	builtIn: boolean;
	createdAt: Date;
	updatedAt: Date;
}
export type SaveCalculatedInput = ProjectReference & {
	create: boolean;
	id: string;
	name: string;
	description: string;
	definition: CalculationDefinition;
};
export type DeleteCalculatedInput = ProjectReference & { id: string };
export function calculatedReference(id: string) {
	return `${CALCULATED_PREFIX}${id}`;
}
export function isCalculatedMetric(name: string) {
	return name.startsWith(CALCULATED_PREFIX);
}
export function commonAttributes<
	T extends { scope: string; key: string; kind: number },
>(catalogs: T[][]): T[] {
	const key = (attribute: T) =>
		`${attribute.scope}/${attribute.key}/${attribute.kind}`;
	const sets = catalogs.map((catalog) => new Set(catalog.map(key)));
	return (catalogs[0] ?? []).filter((attribute) =>
		sets.every((set) => set.has(key(attribute))),
	);
}

export function parseCalculation(value: unknown): CalculationDefinition {
	if (!value || typeof value !== "object")
		throw new InputError("INVALID_QUERY", "Invalid calculation");
	const input = value as Record<string, unknown>;
	if (
		!CALCULATED_UNITS.includes(input.unit as CalculatedUnit) ||
		!Array.isArray(input.inputs) ||
		!input.inputs.length ||
		input.inputs.length > MAX_CALCULATED_INPUTS
	)
		throw new InputError(
			"INVALID_QUERY",
			"Invalid calculated metric inputs or unit",
		);
	const query = parseQuery({
		shape: "table",
		range: { last: "1h" },
		measures: input.inputs,
		formulas: [{ name: "CalculatedOutput", expression: input.expression }],
	});
	if (query.measures.some((measure) => isCalculatedMetric(measure.metric)))
		throw new InputError(
			"INVALID_QUERY",
			"Calculated metrics may only read collected metrics",
		);
	const expression = query.formulas?.[0].expression as string;
	const used = formulaMeasures(
		parseFormula(
			expression,
			query.measures.map((measure) => measure.name),
		),
	);
	if (!used.size)
		throw new InputError(
			"INVALID_QUERY",
			"A calculated metric must read a metric",
		);
	const definition = {
		inputs: query.measures.filter((measure) => used.has(measure.name)),
		expression,
		unit: input.unit as CalculatedUnit,
	};
	if (new TextEncoder().encode(JSON.stringify(definition)).length > 16_384)
		throw new InputError(
			"INVALID_QUERY",
			"Calculated metric definition is too large",
		);
	return definition;
}

const epoch = new Date(0);
export function builtInCalculations(): CalculatedMetric[] {
	return [
		{
			id: "cpu-usage",
			name: m.calculated_cpu_usage(),
			description: m.calculated_cpu_usage_description(),
			inputs: [
				{
					name: "A",
					metric: preset.nodeCpuTime,
					calculation: "rate",
					combine: "sum",
					filters: [
						{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] },
					],
				},
				{
					name: "B",
					metric: preset.nodeCpuTime,
					calculation: "rate",
					combine: "sum",
					filters: [],
				},
			],
			expression: "A / B * 100",
			unit: "%",
		},
		{
			id: "memory-usage",
			name: m.calculated_memory_usage(),
			description: m.calculated_memory_usage_description(),
			inputs: [
				{
					name: "A",
					metric: preset.nodeMemoryAvailable,
					calculation: "avg",
					combine: "sum",
					filters: [],
				},
				{
					name: "B",
					metric: preset.nodeMemoryTotal,
					calculation: "avg",
					combine: "sum",
					filters: [],
				},
			],
			expression: "(1 - A / B) * 100",
			unit: "%",
		},
		{
			id: "process-cpu",
			name: m.calculated_process_cpu(),
			description: m.calculated_process_cpu_description(),
			inputs: [
				{
					name: "A",
					metric: preset.processCpuDistribution,
					calculation: "avg",
					combine: "sum",
					filters: [],
				},
			],
			expression: "A",
			unit: "1",
		},
	].map((definition) => ({
		...definition,
		builtIn: true,
		createdAt: epoch,
		updatedAt: epoch,
	})) as CalculatedMetric[];
}

export function calculatedCatalogMetric(
	definition: CalculatedMetric,
): MetricDefinition {
	return {
		name: calculatedReference(definition.id),
		label: definition.name,
		kind: 1,
		temporality: 0,
		monotonic: null,
		behavior: "gauge",
		presentation: definition.builtIn
			? { section: definition.id === "process-cpu" ? "processes" : "node" }
			: undefined,
		unit: definition.unit,
		description: definition.description,
		firstSeen: definition.createdAt,
		lastSeen: definition.updatedAt,
		calculated: definition,
	};
}

export function availableCalculations(
	definitions: CalculatedMetric[],
	metrics: MetricDefinition[],
) {
	const sources = new Map<string, MetricDefinition>();
	for (const metric of metrics)
		if (!sources.has(metric.name)) sources.set(metric.name, metric);
	return definitions.filter(
		(definition) =>
			!definition.builtIn ||
			definition.inputs.every((input) => {
				const source = sources.get(input.metric);
				return (
					source !== undefined &&
					ALLOWED_CALCULATIONS[source.behavior].includes(input.calculation)
				);
			}),
	);
}
