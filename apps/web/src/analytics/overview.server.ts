import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import type {
	Measure,
	OverviewSection,
	QueryRange,
	QueryResult,
} from "./contracts";
import { INTERVALS } from "./contracts";
import { metricDefinitions } from "./discovery.server";
import { autoInterval } from "./intervals";
import { runQuery } from "./runner.server";
import { resolveRange } from "./validation";

// The fixed fleet overview: premade queries over the collector's node metrics, compared
// with the previous period of the same length. Each section is one runner query, so the
// page shows each as soon as it arrives; the Nodes statistic and table combine them.

const CPU = "recount.node.cpu.time";
const MEMORY_TOTAL = "recount.node.memory.total";
const MEMORY_AVAILABLE = "recount.node.memory.available";
const PROCESSES = "recount.collection.discovered.processes";

export type OverviewStat = "nodes" | OverviewSection;

export interface OverviewPoint {
	bucketMs: number;
	value: number | null;
}

export interface OverviewMetric {
	stat: OverviewStat;
	/** For the whole range: ratios in [0, 1] for cpu and memory, counts otherwise. */
	current: number | null;
	previous: number | null;
	series: OverviewPoint[];
	/** Previous period, shifted forward so its buckets line up with `series`. */
	previousSeries: OverviewPoint[];
}

export type NodeValue = "cpu" | "memory" | "memoryTotal" | "processes";

export interface OverviewNode {
	id: string;
	/** The enrolled node's hostname; null for telemetry from an unknown source. */
	hostname: string | null;
	/** The values of the sections loaded so far. */
	values: Partial<Record<NodeValue, number | null>>;
}

export interface OverviewSectionResult {
	section: OverviewSection;
	bucketSeconds: number;
	metric: OverviewMetric;
	/**
	 * Per node, the buckets in which it sent this section's metric, in this period and
	 * the previous one (shifted like `previousSeries`).
	 */
	reporting: {
		current: Record<string, number[]>;
		previous: Record<string, number[]>;
	};
	nodes: OverviewNode[];
}

type ByNode = Map<string, Map<number, number>>;
/** Each measure's values by node and bucket, for one period. */
type Readings = Record<string, ByNode>;

interface SectionSpec {
	metrics: string[];
	measures: Measure[];
	/** The measure whose samples count a node as reporting. */
	reportedBy: string;
	at: (data: Readings, bucket: number) => number | null;
	/** The whole range's value; the mean of `at` when absent. */
	summary?: (data: Readings) => number | null;
	node: (
		data: Readings,
		id: string,
	) => Partial<Record<NodeValue, number | null>>;
}

function byNode(result: QueryResult, measure: string, comparison: boolean) {
	const nodes: ByNode = new Map();
	for (const series of result.series) {
		if (
			series.measure !== measure ||
			!!series.comparison !== comparison ||
			series.group[0] === null
		)
			continue;
		const buckets = new Map<number, number>();
		for (const point of series.points)
			if (point.bucketMs !== null && point.value !== null)
				buckets.set(point.bucketMs, point.value);
		nodes.set(series.group[0], buckets);
	}
	return nodes;
}

function buckets(from: Date, to: Date, seconds: number) {
	const step = seconds * 1000;
	const list: number[] = [];
	for (
		let bucket = Math.floor(from.getTime() / step) * step;
		bucket < to.getTime();
		bucket += step
	)
		list.push(bucket);
	return list;
}

function sumAt(values: ByNode, bucket: number) {
	let total = 0,
		seen = false;
	for (const node of values.values()) {
		const value = node.get(bucket);
		if (value !== undefined) {
			total += value;
			seen = true;
		}
	}
	return seen ? total : null;
}

function total(values: Iterable<number>) {
	let sum = 0,
		seen = false;
	for (const value of values) {
		sum += value;
		seen = true;
	}
	return seen ? sum : null;
}

function totalOf(values: ByNode) {
	return total([...values.values()].flatMap((node) => [...node.values()]));
}

function ratio(numerator: number | null, denominator: number | null) {
	return numerator !== null && denominator ? numerator / denominator : null;
}

function mean(values: (number | null)[]) {
	const present = values.filter((value): value is number => value !== null);
	return present.length
		? present.reduce((sum, value) => sum + value, 0) / present.length
		: null;
}

function latest(values: Map<number, number> | undefined) {
	if (!values?.size) return null;
	return values.get(Math.max(...values.keys())) ?? null;
}

function used(available: number | null, capacity: number | null) {
	const free = ratio(available, capacity);
	return free === null ? null : 1 - free;
}

const SECTIONS: Record<OverviewSection, SectionSpec> = {
	cpu: {
		metrics: [CPU],
		measures: [
			{
				name: "busy",
				metric: CPU,
				calculation: "rate",
				combine: "sum",
				filters: [
					{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] },
				],
			},
			{ name: "total", metric: CPU, calculation: "rate", combine: "sum" },
		],
		reportedBy: "total",
		at: (data, bucket) =>
			ratio(sumAt(data.busy, bucket), sumAt(data.total, bucket)),
		summary: (data) => ratio(totalOf(data.busy), totalOf(data.total)),
		node: (data, id) => ({
			cpu: ratio(
				total(data.busy.get(id)?.values() ?? []),
				total(data.total.get(id)?.values() ?? []),
			),
		}),
	},
	memory: {
		metrics: [MEMORY_TOTAL, MEMORY_AVAILABLE],
		measures: [
			{
				name: "total",
				metric: MEMORY_TOTAL,
				calculation: "avg",
				combine: "sum",
			},
			{
				name: "available",
				metric: MEMORY_AVAILABLE,
				calculation: "avg",
				combine: "sum",
			},
		],
		reportedBy: "total",
		at: (data, bucket) =>
			used(sumAt(data.available, bucket), sumAt(data.total, bucket)),
		node: (data, id) => {
			const memoryTotal = latest(data.total.get(id));
			return {
				memory: used(latest(data.available.get(id)), memoryTotal),
				memoryTotal,
			};
		},
	},
	processes: {
		metrics: [PROCESSES],
		measures: [
			{
				name: "processes",
				metric: PROCESSES,
				calculation: "avg",
				combine: "sum",
			},
		],
		reportedBy: "processes",
		at: (data, bucket) => sumAt(data.processes, bucket),
		node: (data, id) => ({ processes: latest(data.processes.get(id)) }),
	},
};

function reporting(values: ByNode) {
	return Object.fromEntries(
		[...values].map(([node, points]) => [node, [...points.keys()]]),
	);
}

/**
 * Builds one overview section for an already authorized project, or null when the
 * project has not sent the metrics it needs.
 */
export async function buildOverviewSection(
	projectId: string,
	range: QueryRange,
	section: OverviewSection,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<OverviewSectionResult | null> {
	const spec = SECTIONS[section];
	// Any range, at the interval Explore would pick, compared with the period before it.
	const { from, to } = resolveRange(range);
	const interval = autoInterval(from, to);
	const known = await metricDefinitions(
		connection,
		projectId,
		spec.metrics,
		signal,
	);
	if (spec.metrics.some((metric) => !known.has(metric))) return null;
	const result = await runQuery(
		projectId,
		{
			shape: "timeseries",
			range: { from: from.toISOString(), to: to.toISOString() },
			interval,
			groupBy: ["node"],
			compare: { previous: true },
			measures: spec.measures,
		},
		signal,
		connection,
	);
	const period = (comparison: boolean): Readings =>
		Object.fromEntries(
			spec.measures.map((measure) => [
				measure.name,
				byNode(result, measure.name, comparison),
			]),
		);
	const current = period(false);
	const previous = period(true);
	const list = buckets(from, to, INTERVALS[interval]);
	const pointsOf = (data: Readings) =>
		list.map((bucket) => ({ bucketMs: bucket, value: spec.at(data, bucket) }));
	const summaryOf = (data: Readings, points: OverviewPoint[]) =>
		spec.summary
			? spec.summary(data)
			: mean(points.map((point) => point.value));
	const series = pointsOf(current);
	const previousSeries = pointsOf(previous);
	const ids = new Set(
		Object.values(current).flatMap((values) => [...values.keys()]),
	);
	return {
		section,
		bucketSeconds: INTERVALS[interval],
		metric: {
			stat: section,
			current: summaryOf(current, series),
			previous: summaryOf(previous, previousSeries),
			series,
			previousSeries,
		},
		reporting: {
			current: reporting(current[spec.reportedBy]),
			previous: reporting(previous[spec.reportedBy]),
		},
		nodes: [...ids].map((id) => ({
			id,
			hostname: null,
			values: spec.node(current, id),
		})),
	};
}
