// Compiles the web application's own ClickHouse statements for a load allocation, so the
// k6 query script replays the SQL and settings that browser requests run.
import { parseArgs } from "node:util";
import { compileMeasure } from "../../apps/web/src/analytics/compile.server";
import type {
	AnalyticsQuery,
	Interval,
} from "../../apps/web/src/analytics/contracts";
import { INTERVALS } from "../../apps/web/src/analytics/contracts";
import { ANALYTICS_SETTINGS } from "../../apps/web/src/analytics/runner.server";
import {
	NODE_CHART_SETTINGS,
	telemetryQuery,
} from "../../apps/web/src/executions/telemetry.server";

interface Allocation {
	database: string;
	projects: string[];
	nodes: { id: string; project: number; kind: "direct" | "linux" }[];
}

interface CatalogQuery {
	name: string;
	sql: string;
	params: Record<string, string | number | string[]>;
	settings: Record<string, string | number>;
	/** The sliding window k6 substitutes for `from`, `to`, `firstDay` and `lastDay`. */
	windowSeconds: number;
	/** Bucket width in seconds when the statement has a `step` parameter. */
	stepSeconds: number | null;
}

const { values } = parseArgs({
	options: {
		allocation: { type: "string" },
		out: { type: "string" },
		window: { type: "string", default: "900" },
	},
});
if (!values.allocation || !values.out)
	throw new Error("--allocation and --out are required");
const allocation: Allocation = await Bun.file(values.allocation).json();
const windowSeconds = Number(values.window);
const linux = allocation.nodes.find((node) => node.kind === "linux");
if (!linux) throw new Error("The query catalog needs a Linux node");
const projectId = allocation.projects[linux.project];

function analytics(
	name: string,
	query: AnalyticsQuery,
	kind: number,
	behavior: "gauge" | "counter",
): CatalogQuery {
	const now = new Date();
	const compiled = compileMeasure(
		query,
		query.measures[0],
		{ kind, behavior },
		{
			projectId,
			from: new Date(now.getTime() - windowSeconds * 1000),
			to: now,
		},
	);
	return {
		name,
		sql: compiled.sql,
		params: compiled.params,
		settings: ANALYTICS_SETTINGS,
		windowSeconds,
		stepSeconds:
			query.shape === "timeseries" && query.interval
				? INTERVALS[query.interval]
				: null,
	};
}

const range = { last: "15m" } as const;
const interval: Interval = "10s";
const catalog: CatalogQuery[] = [
	{
		name: "node_chart",
		sql: telemetryQuery,
		params: {
			project: projectId,
			source: linux.id,
			allHosts: 1,
			host: "",
		},
		settings: NODE_CHART_SETTINGS,
		windowSeconds,
		stepSeconds: Math.ceil(windowSeconds / 120),
	},
	analytics(
		"gauge_by_node",
		{
			shape: "timeseries",
			range,
			interval,
			measures: [
				{
					name: "a",
					metric: "recount.node.memory.available",
					calculation: "avg",
					combine: "avg",
				},
			],
			groupBy: ["node"],
		},
		1,
		"gauge",
	),
	analytics(
		"counter_rate_by_execution",
		{
			shape: "timeseries",
			range,
			interval,
			measures: [
				{
					name: "a",
					metric: "process.cpu.time",
					calculation: "rate",
					combine: "sum",
				},
			],
			groupBy: ["execution"],
		},
		2,
		"counter",
	),
	analytics(
		"execution_memory_table",
		{
			shape: "table",
			range,
			measures: [
				{
					name: "a",
					metric: "recount.process.memory.rss",
					calculation: "max",
					combine: "p95",
				},
			],
			filters: [
				{ field: "execution", op: "eq", values: [`load:${linux.project}:0`] },
			],
			groupBy: ["resource.id"],
		},
		1,
		"gauge",
	),
];
await Bun.write(
	values.out,
	JSON.stringify({ database: allocation.database, queries: catalog }, null, 2),
);
console.log(`Wrote ${catalog.length} statements to ${values.out}`);
