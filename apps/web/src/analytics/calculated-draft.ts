import {
	type CalculatedMetric,
	type CalculatedUnit,
	parseCalculation,
} from "./calculated-metrics";
import { formulaMeasures, parseFormula } from "./formula";
import { DEFAULT_DRAFT, type InsightDraft } from "./insight/draft";

export function calculationFromDraft(
	draft: InsightDraft,
	index: number,
	unit: CalculatedUnit,
) {
	try {
		const expression = draft.formulas[index]?.expression ?? "";
		const used = formulaMeasures(
			parseFormula(
				expression,
				draft.series.map((series) => series.name),
			),
		);
		return parseCalculation({
			inputs: draft.series
				.filter((series) => used.has(series.name))
				.map((series) => ({
					name: series.name,
					metric: series.metric,
					calculation: series.calculation,
					combine: series.combine,
					filters: series.filters,
				})),
			expression: draft.formulas[index]?.expression,
			unit,
		});
	} catch {
		return null;
	}
}
export function calculationDraft(definition: CalculatedMetric): InsightDraft {
	const units = {
		"%": "percent",
		By: "bytes",
		s: "seconds",
		"1": "auto",
	} as const;
	return {
		...DEFAULT_DRAFT,
		series: definition.inputs.map((input) => ({
			...input,
			filters: input.filters ?? [],
		})),
		formulas: [{ expression: definition.expression, name: definition.name }],
		display: { ...DEFAULT_DRAFT.display, unit: units[definition.unit] },
	};
}
