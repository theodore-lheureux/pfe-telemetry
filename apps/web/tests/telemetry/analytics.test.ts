import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AnalyticsQuery } from "../../src/analytics/contracts";
import {
	listAttributes,
	listMetrics,
} from "../../src/analytics/discovery.server";
import { runQuery } from "../../src/analytics/runner.server";
import { InputError } from "../../src/lib/input-error";
import {
	createPointFixture,
	from,
	insertPoints,
	ns,
	stringNode,
} from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture();
});
afterAll(async () => {
	await fixture?.close();
});

const SECOND = 1_000_000_000n;
const range = {
	from: from.toISOString(),
	to: new Date(from.getTime() + 300_000).toISOString(),
};

async function gauge(project: string, node: string, at: bigint, value: number) {
	await fixture.client.command({
		query: insertPoints({
			metric_name: "'recount.node.memory.total'",
			metric_kind: "toUInt8(1)",
		}),
		query_params: {
			project,
			source: node,
			host: node,
			time: (ns + at * SECOND).toString(),
			integer: String(value),
			sample: randomUUID(),
			stream: `${node}/memory`,
			epoch: "epoch",
		},
	});
}

async function counter(
	project: string,
	node: string,
	at: bigint,
	value: number,
	options: { stream?: string; mode?: string } = {},
) {
	await fixture.client.command({
		query: insertPoints({
			metric_name: "'recount.node.cpu.time'",
			metric_kind: "toUInt8(2)",
			temporality: "toUInt8(2)",
			monotonic: "CAST(1, 'Nullable(UInt8)')",
			unit: "'s'",
			int_value: "CAST(NULL, 'Nullable(Int64)')",
			double_value: "CAST({double:String}, 'Nullable(Float64)')",
			point_attributes: `[${stringNode("/cpu.mode", "{mode:String}")}]`,
		}),
		query_params: {
			project,
			source: node,
			host: node,
			time: (ns + at * SECOND).toString(),
			integer: null as unknown as string,
			double: String(value),
			mode: options.mode ?? "user",
			sample: randomUUID(),
			stream: options.stream ?? `${node}/cpu/${options.mode ?? "user"}`,
			epoch: "epoch",
		},
	});
}

const run = (project: string, query: AnalyticsQuery) =>
	runQuery(project, query, undefined, fixture.reader);

async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InputError) return error.reason;
		throw error;
	}
	throw new Error("Expected the query to be rejected");
}

test("gauges average per series, then combine per group and across groups", async () => {
	const project = randomUUID();
	await gauge(project, "node-a", 0n, 100);
	await gauge(project, "node-a", 30n, 300);
	await gauge(project, "node-b", 10n, 50);
	const measure = {
		name: "memory",
		metric: "recount.node.memory.total",
		calculation: "avg" as const,
		combine: "sum" as const,
	};
	const grouped = await run(project, {
		shape: "timeseries",
		range,
		interval: "1m",
		measures: [measure],
		groupBy: ["node"],
	});
	expect(grouped.measures[0].unit).toBe("By");
	expect(
		Object.fromEntries(
			grouped.series.map((series) => [series.group[0], series.points]),
		),
	).toEqual({
		"node-a": [{ bucketMs: from.getTime(), value: 200 }],
		"node-b": [{ bucketMs: from.getTime(), value: 50 }],
	});
	const total = await run(project, {
		shape: "table",
		range,
		measures: [measure],
	});
	expect(total.series).toEqual([
		{
			measure: "memory",
			group: [],
			points: [{ bucketMs: null, value: 250 }],
		},
	]);
});

test("counters use positive differences within continuity segments", async () => {
	const project = randomUUID();
	await counter(project, "node-a", 0n, 10);
	await counter(project, "node-a", 30n, 40);
	await counter(project, "node-a", 60n, 100);
	// A restart starts a new continuity segment at a lower value; it is not a drop.
	await counter(project, "node-a", 90n, 5, { stream: "restart" });
	await counter(project, "node-a", 100n, 15, { stream: "restart" });
	await counter(project, "node-a", 30n, 999, { mode: "system" });
	await counter(project, "node-a", 40n, 1009, { mode: "system" });
	const measure = {
		name: "cpu",
		metric: "recount.node.cpu.time",
		calculation: "increase" as const,
		combine: "sum" as const,
		filters: [
			{ field: 'attributes["cpu.mode"]', op: "in" as const, values: ["user"] },
		],
	};
	const increase = await run(project, {
		shape: "timeseries",
		range,
		interval: "1m",
		measures: [measure],
	});
	expect(increase.series[0].points).toEqual([
		{ bucketMs: from.getTime(), value: 30 },
		{ bucketMs: from.getTime() + 60_000, value: 70 },
	]);
	const rate = await run(project, {
		shape: "timeseries",
		range,
		interval: "1m",
		measures: [{ ...measure, calculation: "rate" }],
	});
	expect(rate.series[0].points[0].value).toBeCloseTo(0.5);
	// A range ending 20 s into a bucket divides that bucket's increase by 20 s, not 60 s.
	const partial = await run(project, {
		shape: "timeseries",
		range: {
			from: range.from,
			to: new Date(from.getTime() + 80_000).toISOString(),
		},
		interval: "1m",
		measures: [{ ...measure, calculation: "rate" }],
	});
	expect(partial.series[0].points[1].value).toBeCloseTo(60 / 20);
	const byMode = await run(project, {
		shape: "table",
		range,
		measures: [{ ...measure, filters: [] }],
		groupBy: ['attributes["cpu.mode"]'],
	});
	expect(
		Object.fromEntries(
			byMode.series.map((series) => [series.group[0], series.points[0].value]),
		),
	).toEqual({ user: 100, system: 10 });
});

test("calculations must suit the metric kind, and projects stay isolated", async () => {
	const project = randomUUID(),
		other = randomUUID();
	await counter(project, "node-a", 0n, 1);
	await gauge(other, "node-x", 0n, 7);
	expect(
		await rejection(
			run(project, {
				shape: "table",
				range,
				measures: [
					{
						name: "cpu",
						metric: "recount.node.cpu.time",
						calculation: "avg",
						combine: "sum",
					},
				],
			}),
		),
	).toBe("INVALID_CALCULATION");
	// Another project's metric is unknown here, not merely empty.
	expect(
		await rejection(
			run(project, {
				shape: "table",
				range,
				measures: [
					{
						name: "memory",
						metric: "recount.node.memory.total",
						calculation: "last",
						combine: "sum",
					},
				],
			}),
		),
	).toBe("INVALID_QUERY");
});

test("discovery catalogs metrics and attributes as points arrive", async () => {
	const project = randomUUID();
	await counter(project, "node-a", 0n, 1);
	await gauge(project, "node-a", 0n, 7);
	const metrics = await listMetrics(fixture.reader, project);
	expect(
		metrics.map((metric) => [metric.name, metric.behavior, metric.unit]),
	).toEqual([
		["recount.node.cpu.time", "counter", "s"],
		["recount.node.memory.total", "gauge", "By"],
	]);
	const attributes = await listAttributes(
		fixture.reader,
		project,
		"recount.node.cpu.time",
	);
	const keys = attributes.map(
		(attribute) => `${attribute.scope}:${attribute.key}`,
	);
	expect(keys).toContain("point:cpu.mode");
	expect(keys).toContain("resource:host.id");
	// Continuity markers distinguish segments internally and are never offered.
	expect(keys).not.toContain("resource:recount.host.boot_id");
	expect(keys).not.toContain("resource:recount.collection.epoch_id");
	expect(await listMetrics(fixture.reader, randomUUID())).toEqual([]);
});
