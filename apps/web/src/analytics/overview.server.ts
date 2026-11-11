import type { ClickHouseClient } from "@clickhouse/client";
import { getTelemetryClient } from "../executions/telemetry.server";
import type {
	AnalyticsQuery,
	Interval,
	Measure,
	QueryResult,
	RelativeRange,
} from "./contracts";
import { INTERVALS, RELATIVE_RANGES } from "./contracts";
import { listMetrics } from "./discovery.server";
import { runQuery } from "./runner.server";

// The fixed fleet overview: premade queries over the collector's node metrics, compared
// with the previous period of the same length. It uses only the semantic runner.

export const OVERVIEW_RANGES = ["1h", "24h", "7d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
const OVERVIEW_INTERVAL: Record<OverviewRange, Interval> = {
	"1h": "1m",
	"24h": "15m",
	"7d": "1h",
};

const CPU = "recount.node.cpu.time";
const MEMORY_TOTAL = "recount.node.memory.total";
const MEMORY_AVAILABLE = "recount.node.memory.available";
const PROCESSES = "recount.collection.discovered.processes";

export type OverviewStat = "nodes" | "cpu" | "memory" | "processes";

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

export interface OverviewNode {
	id: string;
	/** The enrolled node's hostname; null for telemetry from an unknown source. */
	hostname: string | null;
	cpu: number | null;
	memory: number | null;
	memoryTotal: number | null;
	processes: number | null;
}

export interface Overview {
	range: OverviewRange;
	from: Date;
	to: Date;
	bucketSeconds: number;
	metrics: OverviewMetric[];
	nodes: OverviewNode[];
	/** False when the project has not sent the node metrics the overview needs. */
	available: boolean;
}

type ByNode = Map<string, Map<number, number>>;

function byNode(result: QueryResult, measure: string): ByNode {
	const nodes: ByNode = new Map();
	for (const series of result.series) {
		if (series.measure !== measure || series.group[0] === null) continue;
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

function ratio(numerator: number | null, denominator: number | null) {
	return numerator !== null && denominator ? numerator / denominator : null;
}

function mean(values: (number | null)[]) {
	const present = values.filter((value): value is number => value !== null);
	return present.length
		? present.reduce((total, value) => total + value, 0) / present.length
		: null;
}

interface Period {
	from: Date;
	to: Date;
	buckets: number[];
	cpuBusy: ByNode;
	cpuTotal: ByNode;
	memoryAvailable: ByNode;
	memoryTotal: ByNode;
	processes: ByNode;
}

async function period(
	projectId: string,
	query: Omit<AnalyticsQuery, "measures">,
	measures: Measure[],
	from: Date,
	to: Date,
	seconds: number,
	signal?: AbortSignal,
	connection?: ClickHouseClient,
): Promise<Period> {
	const result = await runQuery(
		projectId,
		{ ...query, measures },
		signal,
		connection,
	);
	return {
		from,
		to,
		buckets: buckets(from, to, seconds),
		cpuBusy: byNode(result, "cpuBusy"),
		cpuTotal: byNode(result, "cpuTotal"),
		memoryAvailable: byNode(result, "memoryAvailable"),
		memoryTotal: byNode(result, "memoryTotal"),
		processes: byNode(result, "processes"),
	};
}

function fleetSeries(data: Period, stat: OverviewStat, shiftMs = 0) {
	return data.buckets.map((bucket) => {
		let value: number | null;
		if (stat === "cpu")
			value = ratio(sumAt(data.cpuBusy, bucket), sumAt(data.cpuTotal, bucket));
		else if (stat === "memory") {
			const used = ratio(
				sumAt(data.memoryAvailable, bucket),
				sumAt(data.memoryTotal, bucket),
			);
			value = used === null ? null : 1 - used;
		} else if (stat === "processes") value = sumAt(data.processes, bucket);
		else {
			// Nodes reporting: any node with a CPU or memory sample in the bucket.
			const reporting = new Set<string>();
			for (const values of [data.cpuTotal, data.memoryTotal])
				for (const [node, points] of values)
					if (points.has(bucket)) reporting.add(node);
			value = reporting.size || null;
		}
		return { bucketMs: bucket + shiftMs, value };
	});
}

function total(values: ByNode) {
	let sum = 0,
		seen = false;
	for (const node of values.values())
		for (const value of node.values()) {
			sum += value;
			seen = true;
		}
	return seen ? sum : null;
}

function summary(data: Period, stat: OverviewStat) {
	if (stat === "cpu") return ratio(total(data.cpuBusy), total(data.cpuTotal));
	if (stat === "nodes") {
		const nodes = new Set([
			...data.cpuTotal.keys(),
			...data.memoryTotal.keys(),
		]);
		return nodes.size || null;
	}
	return mean(fleetSeries(data, stat).map((point) => point.value));
}

function latest(values: Map<number, number> | undefined) {
	if (!values?.size) return null;
	return values.get(Math.max(...values.keys())) ?? null;
}

/** Builds the overview for an already authorized project. */
export async function buildOverview(
	projectId: string,
	range: OverviewRange,
	signal?: AbortSignal,
	connection: ClickHouseClient = getTelemetryClient(),
): Promise<Overview> {
	const interval = OVERVIEW_INTERVAL[range];
	const seconds = INTERVALS[interval];
	const length = RELATIVE_RANGES[range as RelativeRange] * 1000;
	const to = new Date();
	const from = new Date(to.getTime() - length);
	const previousFrom = new Date(from.getTime() - length);
	const known = new Set(
		(await listMetrics(connection, projectId, signal)).map(
			(metric) => metric.name,
		),
	);
	const measures: Measure[] = [];
	if (known.has(CPU))
		measures.push(
			{
				name: "cpuBusy",
				metric: CPU,
				calculation: "rate",
				combine: "sum",
				filters: [
					{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] },
				],
			},
			{ name: "cpuTotal", metric: CPU, calculation: "rate", combine: "sum" },
		);
	if (known.has(MEMORY_TOTAL) && known.has(MEMORY_AVAILABLE))
		measures.push(
			{
				name: "memoryTotal",
				metric: MEMORY_TOTAL,
				calculation: "avg",
				combine: "sum",
			},
			{
				name: "memoryAvailable",
				metric: MEMORY_AVAILABLE,
				calculation: "avg",
				combine: "sum",
			},
		);
	if (known.has(PROCESSES))
		measures.push({
			name: "processes",
			metric: PROCESSES,
			calculation: "avg",
			combine: "sum",
		});
	if (!measures.length)
		return {
			range,
			from,
			to,
			bucketSeconds: seconds,
			metrics: [],
			nodes: [],
			available: false,
		};
	const query = {
		shape: "timeseries" as const,
		interval,
		groupBy: ["node"],
	};
	// Sequential: the runner allows two concurrent analyses per process.
	const current = await period(
		projectId,
		{ ...query, range: { from: from.toISOString(), to: to.toISOString() } },
		measures,
		from,
		to,
		seconds,
		signal,
		connection,
	);
	const previous = await period(
		projectId,
		{
			...query,
			range: { from: previousFrom.toISOString(), to: from.toISOString() },
		},
		measures,
		previousFrom,
		from,
		seconds,
		signal,
		connection,
	);
	const stats: OverviewStat[] = ["nodes"];
	if (known.has(CPU)) stats.push("cpu");
	if (known.has(MEMORY_TOTAL) && known.has(MEMORY_AVAILABLE))
		stats.push("memory");
	if (known.has(PROCESSES)) stats.push("processes");
	const metrics = stats.map((stat) => ({
		stat,
		current: summary(current, stat),
		previous: summary(previous, stat),
		series: fleetSeries(current, stat),
		previousSeries: fleetSeries(previous, stat, length),
	}));
	const ids = new Set([
		...current.cpuTotal.keys(),
		...current.memoryTotal.keys(),
		...current.processes.keys(),
	]);
	const nodes = [...ids].map((id) => {
		const cpu = ratio(
			[...(current.cpuBusy.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0),
			[...(current.cpuTotal.get(id)?.values() ?? [])].reduce(
				(a, b) => a + b,
				0,
			),
		);
		const memoryTotal = latest(current.memoryTotal.get(id));
		const memoryAvailable = latest(current.memoryAvailable.get(id));
		return {
			id,
			hostname: null,
			cpu,
			memory:
				memoryTotal && memoryAvailable !== null
					? 1 - memoryAvailable / memoryTotal
					: null,
			memoryTotal,
			processes: latest(current.processes.get(id)),
		};
	});
	nodes.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
	return {
		range,
		from,
		to,
		bucketSeconds: seconds,
		metrics,
		nodes,
		available: true,
	};
}
