import type { ChartPoint } from "../../analytics/charts";
import {
	type AnalyticsQuery,
	type Calculation,
	INTERVALS,
	type Interval,
	type MetricDefinition,
	type QueryResult,
} from "../../analytics/contracts";
import { bucketGrid, onGrid } from "../../analytics/insight/grid";

/** The process measurements compared, combined across each execution's processes. */
export const COMPARED_MEASUREMENTS = [
	{ name: "cpu", metric: "process.cpu.time" },
	{ name: "memory", metric: "recount.process.memory.rss" },
	{ name: "io", metric: "process.disk.io" },
] as const;
export type MeasurementName = (typeof COMPARED_MEASUREMENTS)[number]["name"];

/** Counters compare as rates per second, gauges as their last value per bucket. */
function calculationFor(metric: MetricDefinition): Calculation | null {
	switch (metric.behavior) {
		case "counter":
		case "delta":
			return "rate";
		case "gauge":
			return "last";
		case "unsupported":
			return null;
	}
}

export interface PlannedMeasurement {
	name: MeasurementName;
	metric: string;
	/** Null when the project has never received the metric in a comparable form. */
	definition: MetricDefinition | null;
	calculation: Calculation | null;
}

/** Each compared measurement, with the project's definition of its metric if any. */
export function plannedMeasurements(
	catalog: MetricDefinition[],
): PlannedMeasurement[] {
	const byName = new Map(catalog.map((metric) => [metric.name, metric]));
	return COMPARED_MEASUREMENTS.map(({ name, metric }) => {
		const definition = byName.get(metric) ?? null;
		const calculation = definition && calculationFor(definition);
		return {
			name,
			metric,
			definition: calculation ? definition : null,
			calculation,
		};
	});
}

/**
 * The finest interval that keeps the longest execution to 60 elapsed buckets. Buckets
 * shorter than a collection cycle, often 10 seconds, would put each counter increase
 * in one bucket of several and show rates that alternate with gaps.
 */
export function comparisonInterval(durations: number[]): Interval {
	const seconds = Math.max(1, ...durations) / 1000;
	const intervals = Object.entries(INTERVALS) as [Interval, number][];
	return (
		intervals.find(([, step]) => step >= 10 && seconds / step <= 60)?.[0] ??
		"1d"
	);
}

/** One query over both executions, each aligned on its own elapsed time. */
export function comparisonQuery(
	planned: PlannedMeasurement[],
	executions: string[],
	interval: Interval,
): AnalyticsQuery | null {
	const measures = planned.flatMap((entry) =>
		entry.calculation
			? [
					{
						name: entry.name,
						metric: entry.metric,
						calculation: entry.calculation,
						combine: "sum" as const,
					},
				]
			: [],
	);
	if (!measures.length) return null;
	return {
		shape: "timeseries",
		range: { executions },
		interval,
		measures,
	};
}

/**
 * `comparable` when both executions have a value; `incomparable` when only one does, so
 * there is nothing to set it against; `unavailable` when neither does or the project
 * has no such metric.
 */
export type MeasurementStatus = "comparable" | "incomparable" | "unavailable";

export interface ComparedSeries {
	execution: string;
	/** Every elapsed bucket of the execution's period; buckets without a value are null. */
	points: ChartPoint[];
	recorded: boolean;
}

export interface ComparedMeasurement {
	status: MeasurementStatus;
	series: ComparedSeries[];
}

/**
 * A measurement's aligned series for each execution, in their order. `durationMs` is
 * the client's own period, used only until the result lists the server's.
 */
export function comparedMeasurement(
	result: QueryResult | undefined,
	name: MeasurementName,
	executions: { key: string; durationMs: number }[],
): ComparedMeasurement {
	const bucketSeconds = result?.bucketSeconds ?? 60;
	const series = executions.map(({ key, durationMs }): ComparedSeries => {
		const found = result?.series.find(
			(entry) => entry.measure === name && entry.execution === key,
		);
		const points = (found?.points ?? []).flatMap((point) =>
			point.bucketMs === null
				? []
				: [{ bucketMs: point.bucketMs, value: point.value }],
		);
		// The server's period decides the grid once the result arrives; the last sighting
		// is inclusive, so its bucket belongs to the grid.
		const period = result?.executions?.find((entry) => entry.execution === key);
		const length = period
			? period.to.getTime() - period.from.getTime()
			: durationMs;
		const grid = bucketGrid(new Date(0), new Date(length + 1), bucketSeconds);
		return {
			execution: key,
			points: onGrid(points, grid),
			recorded: points.some((point) => point.value !== null),
		};
	});
	const recorded = series.filter((entry) => entry.recorded).length;
	let status: MeasurementStatus = "comparable";
	if (recorded === 0) status = "unavailable";
	else if (recorded < series.length) status = "incomparable";
	return { status, series };
}
