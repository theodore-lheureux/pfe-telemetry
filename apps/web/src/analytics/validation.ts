import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	type AnalyticsQuery,
	type Calculation,
	COMBINES,
	COMPARE_UNITS,
	type Combine,
	type CompareUnit,
	type Comparison,
	type CoreField,
	DEFAULT_SERIES_LIMIT,
	type Filter,
	type FilterOperator,
	INTERVALS,
	type Interval,
	MAX_BUCKETS,
	MAX_FILTERS,
	MAX_FORMULAS,
	MAX_GROUP_BY,
	MAX_MEASURES,
	MAX_RANGE_SECONDS,
	MAX_RESULT_POINTS,
	MAX_SERIES,
	type Measure,
	type MetricAttributesInput,
	type MetricBehavior,
	OVERVIEW_SECTIONS,
	type OverviewSection,
	RELATIVE_RANGES,
	type RelativeRange,
	type RunQueryInput,
} from "./contracts";
import { parseAttributeField } from "./fields";
import { FormulaError, parseFormula } from "./formula";

const CORE_FIELDS: readonly CoreField[] = [
	"node",
	"host",
	"resource.id",
	"resource.kind",
	"scope.name",
];
const CALCULATIONS: readonly Calculation[] = [
	"last",
	"avg",
	"min",
	"max",
	"rate",
	"increase",
];
const OPERATORS: readonly FilterOperator[] = [
	"eq",
	"neq",
	"in",
	"not_in",
	"exists",
	"not_exists",
];
const METRIC_NAME = /^[^\p{Cc}]{1,255}$/u;
const MEASURE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Calculations each metric behavior allows, from the semantic model. */
export const ALLOWED_CALCULATIONS: Record<
	MetricBehavior,
	readonly Calculation[]
> = {
	gauge: ["last", "avg", "min", "max"],
	counter: ["rate", "increase"],
	delta: ["increase", "rate"],
	unsupported: [],
};

/** Classifies a stored metric by OTLP kind, temporality and monotonicity. */
export function metricBehavior(
	kind: number,
	temporality: number,
	monotonic: boolean | null,
): MetricBehavior {
	if (kind === 1) return "gauge";
	if (kind === 2) {
		if (monotonic !== true) return "gauge";
		if (temporality === 2) return "counter";
		if (temporality === 1) return "delta";
	}
	return "unsupported";
}

export type ParsedField =
	| { type: "core"; name: CoreField }
	| { type: "attribute"; scope: "point" | "resource"; key: string };

export function parseField(value: unknown): ParsedField {
	if (typeof value !== "string")
		throw new InputError("INVALID_QUERY", "Field must be a string");
	if ((CORE_FIELDS as readonly string[]).includes(value))
		return { type: "core", name: value as CoreField };
	const attribute = parseAttributeField(value);
	if (attribute) return { type: "attribute", ...attribute };
	throw new InputError("INVALID_QUERY", `Unknown field ${value.slice(0, 64)}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InputError("INVALID_QUERY", `Invalid ${what}`);
	return value as Record<string, unknown>;
}

function list(value: unknown, max: number, what: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > max)
		throw new InputError("INVALID_QUERY", `Invalid ${what}`);
	return value;
}

export function parseFilter(value: unknown): Filter {
	const input = record(value, "filter");
	parseField(input.field);
	if (!OPERATORS.includes(input.op as FilterOperator))
		throw new InputError("INVALID_QUERY", "Invalid filter operator");
	const op = input.op as FilterOperator;
	if (op === "exists" || op === "not_exists")
		return { field: input.field as string, op };
	const values = list(input.values, 100, "filter values");
	if (
		!values.length ||
		((op === "eq" || op === "neq") && values.length !== 1) ||
		!values.every(
			(item) =>
				typeof item === "string" &&
				item.length <= 1024 &&
				!/\p{Cc}/u.test(item),
		)
	)
		throw new InputError("INVALID_QUERY", "Invalid filter values");
	return { field: input.field as string, op, values: values as string[] };
}

function parseMeasure(value: unknown): Measure {
	const input = record(value, "measure");
	if (typeof input.name !== "string" || !MEASURE_NAME.test(input.name))
		throw new InputError("INVALID_QUERY", "Invalid measure name");
	if (typeof input.metric !== "string" || !METRIC_NAME.test(input.metric))
		throw new InputError("INVALID_QUERY", "Invalid metric");
	if (!CALCULATIONS.includes(input.calculation as Calculation))
		throw new InputError("INVALID_QUERY", "Invalid calculation");
	if (!COMBINES.includes(input.combine as Combine))
		throw new InputError("INVALID_QUERY", "Invalid combination");
	return {
		name: input.name,
		metric: input.metric,
		calculation: input.calculation as Calculation,
		combine: input.combine as Combine,
		filters: list(input.filters, MAX_FILTERS, "measure filters").map(
			parseFilter,
		),
	};
}

/** Resolves a query range to absolute bounds, once per run. */
export function resolveRange(
	range: AnalyticsQuery["range"],
	now = new Date(),
): { from: Date; to: Date } {
	if ("last" in range) {
		const seconds = RELATIVE_RANGES[range.last];
		return { from: new Date(now.getTime() - seconds * 1000), to: now };
	}
	return { from: new Date(range.from), to: new Date(range.to) };
}

function parseRange(value: unknown): AnalyticsQuery["range"] {
	const input = record(value, "range");
	if ("last" in input) {
		if (!Object.hasOwn(RELATIVE_RANGES, input.last as string))
			throw new InputError("INVALID_TIME_RANGE", "Invalid relative range");
		return { last: input.last as RelativeRange };
	}
	const from = new Date(input.from as string),
		to = new Date(input.to as string);
	const seconds = (to.getTime() - from.getTime()) / 1000;
	if (
		typeof input.from !== "string" ||
		typeof input.to !== "string" ||
		!Number.isFinite(seconds) ||
		seconds <= 0 ||
		seconds > MAX_RANGE_SECONDS ||
		from.getTime() < 0
	)
		throw new InputError("INVALID_TIME_RANGE", "Invalid time range");
	return { from: from.toISOString(), to: to.toISOString() };
}

export function parseQuery(value: unknown): AnalyticsQuery {
	const input = record(value, "query");
	if (input.shape !== "timeseries" && input.shape !== "table")
		throw new InputError("INVALID_QUERY", "Invalid result shape");
	const range = parseRange(input.range);
	let interval: Interval | undefined;
	let buckets = 1;
	if (input.shape === "timeseries") {
		if (!Object.hasOwn(INTERVALS, input.interval as string))
			throw new InputError("INVALID_QUERY", "Invalid interval");
		interval = input.interval as Interval;
		const { from, to } = resolveRange(range);
		buckets = Math.ceil(
			(to.getTime() - from.getTime()) / 1000 / INTERVALS[interval],
		);
		if (buckets > MAX_BUCKETS)
			throw new InputError(
				"INVALID_TIME_RANGE",
				"Interval is too small for this range",
			);
	}
	const measures = list(input.measures, MAX_MEASURES, "measures").map(
		parseMeasure,
	);
	if (!measures.length)
		throw new InputError("INVALID_QUERY", "At least one measure is required");
	if (new Set(measures.map((measure) => measure.name)).size !== measures.length)
		throw new InputError("INVALID_QUERY", "Measure names must be unique");
	const groupBy = list(input.groupBy, MAX_GROUP_BY, "grouping");
	for (const field of groupBy) parseField(field);
	if (new Set(groupBy).size !== groupBy.length)
		throw new InputError("INVALID_QUERY", "Grouping fields must be unique");
	const formulas = list(input.formulas, MAX_FORMULAS, "formulas").map(
		(entry) => {
			const formula = record(entry, "formula");
			if (typeof formula.name !== "string" || !MEASURE_NAME.test(formula.name))
				throw new InputError("INVALID_QUERY", "Invalid formula name");
			if (typeof formula.expression !== "string")
				throw new InputError("INVALID_QUERY", "Invalid formula");
			try {
				parseFormula(
					formula.expression,
					measures.map((measure) => measure.name),
				);
			} catch (error) {
				throw new InputError(
					"INVALID_QUERY",
					error instanceof FormulaError ? error.message : "Invalid formula",
				);
			}
			return { name: formula.name, expression: formula.expression };
		},
	);
	const names = [...measures, ...formulas].map((entry) => entry.name);
	if (new Set(names).size !== names.length)
		throw new InputError("INVALID_QUERY", "Series names must be unique");
	if (
		input.limit !== undefined &&
		(!Number.isInteger(input.limit) ||
			(input.limit as number) < 1 ||
			(input.limit as number) > MAX_SERIES)
	)
		throw new InputError("INVALID_QUERY", "Invalid series limit");
	if (input.other !== undefined && typeof input.other !== "boolean")
		throw new InputError("INVALID_QUERY", "Invalid other option");
	if (
		input.aggregate !== undefined &&
		(!COMBINES.includes(input.aggregate as Combine) || !groupBy.length)
	)
		throw new InputError("INVALID_QUERY", "Invalid group aggregation");
	// Every measure returns up to limit + 1 groups (the extra one, or Other) per bucket;
	// an aggregation reads up to the largest groups allowed.
	const limit =
		input.aggregate === undefined
			? ((input.limit as number | undefined) ?? DEFAULT_SERIES_LIMIT)
			: MAX_SERIES;
	const groups = groupBy.length ? limit + 1 : 1;
	if (measures.length * groups * buckets > MAX_RESULT_POINTS)
		throw new InputError(
			"INVALID_QUERY",
			"Too many series for this range: lower the series limit or use a longer interval",
		);
	return {
		shape: input.shape,
		range,
		...(interval && { interval }),
		measures,
		...(formulas.length ? { formulas } : {}),
		filters: list(input.filters, MAX_FILTERS, "filters").map(parseFilter),
		groupBy: groupBy as string[],
		...(input.limit === undefined ? {} : { limit: input.limit as number }),
		...(input.other ? { other: true } : {}),
		...(input.compare === undefined
			? {}
			: { compare: parseComparison(input.compare) }),
		...(input.aggregate === undefined
			? {}
			: { aggregate: input.aggregate as Combine }),
	};
}

function parseComparison(value: unknown): Comparison {
	const input = record(value, "comparison");
	if (input.previous === true) return { previous: true };
	if (
		COMPARE_UNITS.includes(input.unit as CompareUnit) &&
		Number.isInteger(input.amount) &&
		(input.amount as number) >= 1 &&
		(input.amount as number) <= 365
	)
		return { amount: input.amount as number, unit: input.unit as CompareUnit };
	throw new InputError("INVALID_QUERY", "Invalid comparison");
}

/** The comparison window for a resolved range. */
const UNIT_MS = { hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };

export function comparisonRange(
	comparison: Comparison,
	from: Date,
	to: Date,
): { from: Date; to: Date } {
	if ("previous" in comparison) {
		const length = to.getTime() - from.getTime();
		return { from: new Date(from.getTime() - length), to: from };
	}
	const shift = (date: Date) => {
		const shifted = new Date(date);
		if (comparison.unit === "months")
			shifted.setUTCMonth(shifted.getUTCMonth() - comparison.amount);
		else
			shifted.setTime(
				shifted.getTime() - comparison.amount * UNIT_MS[comparison.unit],
			);
		return shifted;
	};
	return { from: shift(from), to: shift(to) };
}

export function parseRunQueryInput(value: unknown): RunQueryInput {
	return {
		...parseProjectReference(value),
		query: parseQuery(record(value, "request").query),
	};
}

export function parseMetricName(value: unknown): string {
	if (typeof value !== "string" || !METRIC_NAME.test(value))
		throw new InputError("INVALID_QUERY", "Invalid metric");
	return value;
}

export function parseMetricAttributesInput(
	value: unknown,
): MetricAttributesInput {
	const metric = record(value, "request").metric;
	if (metric === undefined) return parseProjectReference(value);
	return { ...parseProjectReference(value), metric: parseMetricName(metric) };
}

export function parseOverviewInput(value: unknown) {
	const request = record(value, "request");
	if (!OVERVIEW_SECTIONS.includes(request.section as OverviewSection))
		throw new InputError("INVALID_QUERY", "Invalid overview section");
	return {
		...parseProjectReference(value),
		range: parseRange(request.range),
		section: request.section as OverviewSection,
	};
}
