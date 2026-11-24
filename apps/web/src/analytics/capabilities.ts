import {
	type AttributeDefinition,
	type Calculation,
	type Combine,
	HISTOGRAM_PERCENTILES,
	type MetricBehavior,
	type MetricDefinition,
} from "./contracts";
import { isFieldKey } from "./fields";
import { chartPolicy, DISPLAY_TYPES } from "./insight/panels/chart-policy";
import { countNoun, rateUnit } from "./metric-units";

export const ALLOWED_CALCULATIONS: Record<
	MetricBehavior,
	readonly Calculation[]
> = {
	gauge: ["last", "avg", "min", "max", "sum"],
	counter: ["rate", "increase"],
	delta: ["increase", "rate"],
	histogram: [...HISTOGRAM_PERCENTILES, "avg", "count"],
	unsupported: [],
};

const SCALAR_CHARTS = DISPLAY_TYPES.filter(
	(type) => !chartPolicy(type).needsHistogram,
);

export function capabilities(
	series?: Partial<
		Pick<
			MetricDefinition,
			"behavior" | "unit" | "calculated" | "defaultBreakdown" | "presentation"
		>
	> & { calculation?: Calculation },
	attributes?: AttributeDefinition[],
) {
	const behavior = series?.behavior ?? "unsupported";
	const histogram = behavior === "histogram";
	const coverage = series?.presentation?.coverage;
	const unit = series?.unit ?? "";
	const gauge = behavior === "gauge" && !series?.calculated;
	let defaultCalculation: Calculation = "rate";
	if (histogram) defaultCalculation = "p95";
	if (gauge) defaultCalculation = "avg";
	if (series?.calculated) defaultCalculation = "last";
	return {
		histogram,
		percentileOfSeries: HISTOGRAM_PERCENTILES.some(
			(value) => value === series?.calculation,
		),
		showCombine: !histogram,
		calculations: ALLOWED_CALCULATIONS[behavior],
		defaultCalculation,
		defaultCombine: (gauge ? "avg" : "sum") as Combine,
		charts: histogram ? DISPLAY_TYPES : SCALAR_CHARTS,
		breakdown: series?.defaultBreakdown,
		attributes: attributes?.filter(
			({ key, status }) => status !== "hidden" && isFieldKey(key),
		),
		unit,
		coverage,
	};
}

export function calculatedValueUnit(unit: string, calculation: Calculation) {
	return calculation === "rate" ? rateUnit(unit) : unit;
}

export function resultCountUnit(unit: string, calculation: Calculation) {
	return calculation === "count" ? countNoun(unit) : null;
}
