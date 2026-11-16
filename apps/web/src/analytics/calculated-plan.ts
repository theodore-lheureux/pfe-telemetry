import { InputError } from "../lib/input-error";
import { aggregateGroups } from "./aggregate";
import {
	type CalculatedMetric,
	isCalculatedMetric,
} from "./calculated-metrics";
import {
	type AnalyticsQuery,
	MAX_SERIES,
	type Measure,
	type QueryResult,
} from "./contracts";
import { formulaSeries } from "./formula-series";
import { parseQuery } from "./validation";

export function calculatedPlan(
	input: AnalyticsQuery,
	definitions: ReadonlyMap<string, CalculatedMetric>,
) {
	const reserved = new Set(
		[...input.measures, ...(input.formulas ?? [])].map((entry) => entry.name),
	);
	let index = 0;
	const nextName = () => {
		// Short aliases preserve the expression length budget during expansion.
		const short = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
			.split("")
			.find((name) => !reserved.has(name));
		if (short) {
			reserved.add(short);
			return short;
		}
		while (reserved.has(`I${index}`)) index++;
		const name = `I${index++}`;
		reserved.add(name);
		return name;
	};
	const measures: Measure[] = [];
	const formulas: NonNullable<AnalyticsQuery["formulas"]> = [];
	for (const measure of input.measures) {
		if (!isCalculatedMetric(measure.metric)) {
			measures.push(measure);
			continue;
		}
		const definition = definitions.get(measure.metric);
		if (!definition)
			throw new InputError(
				"INVALID_QUERY",
				"Calculated metric not found in this project",
			);
		if (
			measure.calculation !== "last" ||
			measure.combine !== "sum" ||
			input.spread
		)
			throw new InputError(
				"INVALID_CALCULATION",
				"Calculated metrics use their saved calculation and cannot show source spread",
			);
		const names = new Map(
			definition.inputs.map((entry) => [entry.name, nextName()]),
		);
		measures.push(
			...definition.inputs.map((entry) => ({
				...entry,
				name: names.get(entry.name) as string,
				filters: [...(entry.filters ?? []), ...(measure.filters ?? [])],
			})),
		);
		formulas.push({
			name: measure.name,
			expression: definition.expression.replace(
				/\b[A-Za-z][A-Za-z0-9_]*\b/g,
				(name) => names.get(name) ?? name,
			),
		});
	}
	const { aggregate: _aggregate, ...query } = input;
	const expanded = parseQuery({
		...query,
		measures,
		formulas,
		...(input.aggregate ? { limit: MAX_SERIES, other: false } : {}),
	});
	return {
		query: expanded,
		finish(result: QueryResult): QueryResult {
			const visible = new Set(input.measures.map((measure) => measure.name));
			const series = result.series.filter((entry) =>
				visible.has(entry.measure),
			);
			const all = [...series, ...formulaSeries(input, series)];
			return {
				...result,
				formulas: input.formulas ?? [],
				measures: input.measures.map((measure) => {
					const definition = definitions.get(measure.metric);
					if (definition)
						return {
							name: measure.name,
							metric: measure.metric,
							label: definition.name,
							unit: definition.unit,
							calculation: measure.calculation,
						};
					const original = result.measures.find(
						(entry) => entry.name === measure.name,
					);
					if (!original)
						throw new InputError("INVALID_QUERY", "Missing measure result");
					return original;
				}),
				series: input.aggregate ? aggregateGroups(all, input.aggregate) : all,
				...(input.aggregate ? { aggregate: input.aggregate } : {}),
			};
		},
	};
}
