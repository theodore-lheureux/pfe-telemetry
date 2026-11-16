import { expect, test } from "bun:test";
import { calculationFromDraft } from "../../src/analytics/calculated-draft";
import {
	availableCalculations,
	builtInCalculations,
	calculatedCatalogMetric,
	calculatedReference,
	commonAttributes,
	isCalculatedMetric,
	parseCalculation,
} from "../../src/analytics/calculated-metrics";
import { calculatedPlan } from "../../src/analytics/calculated-plan";
import type {
	AnalyticsQuery,
	MetricDefinition,
	QueryResult,
	SeriesResult,
} from "../../src/analytics/contracts";
import { formulaSeries } from "../../src/analytics/formula-series";
import { DEFAULT_DRAFT, newSeries } from "../../src/analytics/insight/draft";

const cpu = () => builtInCalculations()[0];
const query = (): AnalyticsQuery => ({
	shape: "timeseries",
	range: { last: "1h" },
	interval: "1m",
	measures: [
		{
			name: "A",
			metric: calculatedReference(cpu().id),
			calculation: "last",
			combine: "sum",
		},
	],
});
test("built-ins are first-class metrics backed by collected inputs, not editor presets", () => {
	const definitions = builtInCalculations();
	expect(definitions.map((definition) => definition.id)).toEqual([
		"cpu-usage",
		"memory-usage",
		"process-cpu",
	]);
	for (const definition of definitions) {
		expect(parseCalculation(definition)).toEqual({
			inputs: definition.inputs,
			expression: definition.expression,
			unit: definition.unit,
		});
		expect(calculatedCatalogMetric(definition)).toMatchObject({
			label: definition.name,
			calculated: definition,
		});
		expect(isCalculatedMetric(calculatedCatalogMetric(definition).name)).toBe(
			true,
		);
		expect(
			definition.inputs.every((input) => !isCalculatedMetric(input.metric)),
		).toBe(true);
	}
});

test("built-ins are offered only when their current collected inputs support the calculation", () => {
	const raw = {
		name: "recount.node.cpu.time",
		kind: 2,
		temporality: 2,
		monotonic: true,
		behavior: "counter",
		unit: "s",
		description: "",
		firstSeen: new Date(0),
		lastSeen: new Date(0),
	} satisfies MetricDefinition;
	expect(
		availableCalculations(builtInCalculations(), [raw]).map(
			(definition) => definition.id,
		),
	).toEqual(["cpu-usage"]);
	expect(
		availableCalculations(builtInCalculations(), [
			{ ...raw, behavior: "gauge" },
		]),
	).toEqual([]);
});
test("saving a formula captures only its raw dependencies and per-input filters", () => {
	const definition = cpu();
	const draft = {
		...DEFAULT_DRAFT,
		series: [
			...definition.inputs.map((input) => ({
				...input,
				filters: input.filters ?? [],
			})),
			newSeries("C"),
		],
		formulas: [{ expression: definition.expression }],
		filters: [{ field: "node", op: "eq" as const, values: ["selected"] }],
	};
	expect(calculationFromDraft(draft, 0, "%")).toEqual({
		inputs: definition.inputs,
		expression: definition.expression,
		unit: "%",
	});
	expect(() =>
		parseCalculation({
			...definition,
			inputs: definition.inputs.map((input, index) =>
				index === 0
					? { ...input, metric: calculatedReference("other") }
					: input,
			),
		}),
	).toThrow("Calculated metrics may only read collected metrics");
	expect(() =>
		parseCalculation({ ...definition, expression: "fetch(A)" }),
	).toThrow();
	expect(() => parseCalculation({ ...definition, expression: "42" })).toThrow();
});
test("calculated query execution hides inputs, preserves window isolation and composes with insight formulas", () => {
	const input = {
		...query(),
		formulas: [{ name: "F1", expression: "A * 2" }],
		compare: { previous: true as const },
	};
	const definition = cpu();
	const plan = calculatedPlan(
		input,
		new Map([[calculatedReference(definition.id), definition]]),
	);
	expect(plan.query.measures).toHaveLength(2);
	expect(plan.query.measures[0].filters).toEqual(definition.inputs[0].filters);
	const [busy, total] = plan.query.measures;
	const source: SeriesResult[] = [
		{
			measure: busy.name,
			group: [],
			points: [
				{ bucketMs: 0, value: 40 },
				{ bucketMs: 60_000, value: 10 },
			],
		},
		{
			measure: total.name,
			group: [],
			points: [
				{ bucketMs: 0, value: 100 },
				{ bucketMs: 60_000, value: 0 },
			],
		},
		{
			measure: busy.name,
			group: [],
			comparison: true,
			points: [{ bucketMs: 0, value: 30 }],
		},
		{
			measure: total.name,
			group: [],
			comparison: true,
			points: [{ bucketMs: 0, value: 100 }],
		},
	];
	const raw: QueryResult = {
		shape: input.shape,
		from: new Date(0),
		to: new Date(120_000),
		bucketSeconds: 60,
		groupBy: [],
		measures: plan.query.measures.map((measure) => ({
			name: measure.name,
			metric: measure.metric,
			unit: "s",
			calculation: measure.calculation,
		})),
		formulas: plan.query.formulas ?? [],
		series: [...source, ...formulaSeries(plan.query, source)],
		limited: false,
		compared: { from: new Date(-120_000), to: new Date(0) },
		coverage: null,
	};
	const result = plan.finish(raw);
	expect(result.measures).toEqual([
		{
			name: "A",
			metric: calculatedReference(definition.id),
			label: "CPU usage",
			unit: "%",
			calculation: "last",
		},
	]);
	expect(result.series.map((series) => series.measure)).toEqual([
		"A",
		"A",
		"F1",
		"F1",
	]);
	expect(result.series[0].points.map((point) => point.value)).toEqual([
		40,
		null,
	]);
	expect(result.series[1].points[0].value).toBe(30);
	expect(result.series[2].points[0].value).toBe(80);
	expect(result.series[3].points[0].value).toBe(60);
	expect(result.formulas).toEqual(input.formulas);
	expect(() => calculatedPlan(input, new Map())).toThrow();
	expect(() =>
		calculatedPlan(
			{ ...input, spread: "range" },
			new Map([[calculatedReference(definition.id), definition]]),
		),
	).toThrow();
});

test("calculated dimensions require the same key, scope and value type on every input", () => {
	const shared = { scope: "resource", key: "host.name", kind: 2 };
	expect(
		commonAttributes([
			[
				shared,
				{ scope: "point", key: "cpu.mode", kind: 2 },
				{ scope: "point", key: "mixed", kind: 2 },
			],
			[
				shared,
				{ scope: "resource", key: "cpu.mode", kind: 2 },
				{ scope: "point", key: "mixed", kind: 3 },
			],
		]),
	).toEqual([shared]);
});
