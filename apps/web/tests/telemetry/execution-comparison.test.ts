import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AnalyticsQuery } from "../../src/analytics/contracts";
import { runQuery } from "../../src/analytics/runner.server";
import { parseQuery } from "../../src/analytics/validation";
import { comparedMeasurement } from "../../src/executions/compare/measurements";
import { OperationError } from "../../src/lib/operation-error";
import { executionParticipant } from "../execution-participant";
import { createPointFixture, insertPoints, ns } from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture({ participants: true });
});
afterAll(async () => {
	await fixture?.close();
});

const second = 1_000_000_000n;
const ms = 1_000_000n;
const nanoDate = (value: bigint) => new Date(Number(value / ms));

/** A process membership of `key` on `node` from `start` to `end`. */
function membership(
	project: string,
	key: string,
	node: string,
	resource: string,
	start: bigint,
	end: bigint,
) {
	return {
		...executionParticipant(project, key, { nodeId: node, firstSeen: start }),
		kind: 2,
		process_resource_id: resource,
		process_namespace_id: "pidns:1",
		process_pid: 42,
		process_start_time_ticks: "100",
		execution_name: null,
		workload_version: null,
		parameters: [],
		last_seen_unix_nano: end.toString(),
		owner_uid: 1000,
	};
}

const metrics = {
	cpu: {
		metric_name: "'process.cpu.time'",
		metric_kind: "toUInt8(2)",
		temporality: "toUInt8(2)",
		monotonic: "CAST(1, 'Nullable(UInt8)')",
		unit: "'s'",
	},
	memory: {
		metric_name: "'recount.process.memory.rss'",
		metric_kind: "toUInt8(1)",
		temporality: "toUInt8(0)",
		monotonic: "CAST(NULL, 'Nullable(UInt8)')",
		unit: "'By'",
	},
};

async function point(
	project: string,
	node: string,
	resource: string,
	metric: keyof typeof metrics,
	at: bigint,
	value: number,
) {
	await fixture.client.command({
		query: insertPoints({
			resource_id: "{resource:String}",
			resource_kind: "toUInt8(4)",
			...metrics[metric],
		}),
		query_params: {
			project,
			source: node,
			host: node,
			resource,
			time: at.toString(),
			integer: String(value),
			sample: randomUUID(),
			stream: `${node}/${resource}/${metric}`,
			epoch: "epoch",
		},
	});
}

const insertFacts = (values: object[]) =>
	fixture.client.insert({
		table: "execution_participants",
		values,
		format: "JSONEachRow",
	});

const measures = [
	{
		name: "cpu",
		metric: "process.cpu.time",
		calculation: "rate",
		combine: "sum",
	},
	{
		name: "memory",
		metric: "recount.process.memory.rss",
		calculation: "last",
		combine: "sum",
	},
] as const;

const run = (project: string, query: Partial<AnalyticsQuery>) =>
	runQuery(
		project,
		parseQuery({
			shape: "timeseries",
			interval: "10s",
			measures,
			...query,
		}),
		undefined,
		fixture.reader,
	);

async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) return error.code;
		if (error && typeof error === "object" && "reason" in error)
			return String(error.reason);
		throw error;
	}
	throw new Error("Expected the query to fail");
}

/**
 * Execution A runs first; B starts an hour later at an offset that is not on the
 * interval grid, on the same node. Only A records memory; B misses one CPU sample.
 */
async function seed() {
	const project = randomUUID(),
		node = randomUUID();
	const startA = ns;
	const startB = ns + 3600n * second + 3250n * ms;
	await insertFacts([
		membership(project, "run:a", node, "proc-a", startA, startA + 30n * second),
		membership(project, "run:b", node, "proc-b", startB, startB + 30n * second),
	]);
	for (const [index, value] of [0, 5, 10, 15].entries())
		await point(
			project,
			node,
			"proc-a",
			"cpu",
			startA + BigInt(index) * 10n * second,
			value,
		);
	for (const [at, value] of [
		[0n, 0],
		[10n, 20],
		[30n, 60],
	] as const)
		await point(project, node, "proc-b", "cpu", startB + at * second, value);
	await point(project, node, "proc-a", "memory", startA + 5n * second, 1024);
	await point(project, node, "proc-a", "memory", startA + 25n * second, 4096);
	// Load from another process on the shared node belongs to neither execution.
	await point(project, node, "proc-other", "cpu", startB, 0);
	await point(project, node, "proc-other", "cpu", startB + 10n * second, 900);
	return { project, node, startA, startB };
}

test("executions with different start times align on their own elapsed buckets", async () => {
	const { project, startA, startB } = await seed();
	const result = await run(project, {
		range: { executions: ["run:a", "run:b"] },
	});
	expect(result.executions).toEqual([
		{
			execution: "run:a",
			from: nanoDate(startA),
			to: nanoDate(startA + 30n * second),
		},
		{
			execution: "run:b",
			from: nanoDate(startB),
			to: nanoDate(startB + 30n * second),
		},
	]);
	expect(result.from.getTime()).toBe(0);
	expect(result.to.getTime()).toBe(30_001);
	expect(result.coverage).toBeNull();
	const series = (measure: string, execution: string) =>
		result.series.find(
			(entry) => entry.measure === measure && entry.execution === execution,
		)?.points;
	// A counter's first sample has no predecessor, so bucket 0 is empty. The last bucket
	// holds only the final sighting, whose difference spans the 10 seconds before it.
	expect(series("cpu", "run:a")).toEqual([
		{ bucketMs: 10_000, value: 0.5 },
		{ bucketMs: 20_000, value: 0.5 },
		{ bucketMs: 30_000, value: 0.5 },
	]);
	// B's buckets start at its own first sighting, not on the 10-second grid. The missing
	// sample leaves a gap rather than a zero, and the difference across it spans 20
	// seconds, so B keeps its steady two cores.
	expect(series("cpu", "run:b")).toEqual([
		{ bucketMs: 10_000, value: 2 },
		{ bucketMs: 30_000, value: 2 },
	]);
	expect(series("memory", "run:a")).toEqual([
		{ bucketMs: 0, value: 1024 },
		{ bucketMs: 20_000, value: 4096 },
	]);
	expect(series("memory", "run:b")).toBeUndefined();

	const durations = [
		{ key: "run:a", durationMs: 30_000 },
		{ key: "run:b", durationMs: 30_000 },
	];
	expect(comparedMeasurement(result, "cpu", durations).status).toBe(
		"comparable",
	);
	const memory = comparedMeasurement(result, "memory", durations);
	expect(memory.status).toBe("incomparable");
	expect(memory.series[0].points.map((entry) => entry.value)).toEqual([
		1024,
		null,
		4096,
		null,
	]);
});

test("rates stay exact in a final bucket that is longer than the sampling interval and partly empty", async () => {
	const project = randomUUID(),
		node = randomUUID();
	const startMid = ns;
	const startEdge = ns + 3600n * second;
	await insertFacts([
		membership(
			project,
			"run:mid",
			node,
			"proc-mid",
			startMid,
			startMid + 90n * second,
		),
		membership(
			project,
			"run:edge",
			node,
			"proc-edge",
			startEdge,
			startEdge + 60n * second,
		),
	]);
	// One core for 90 seconds, ending mid-bucket; two cores for 60 seconds, ending with a
	// sample exactly on the boundary of a new bucket.
	for (let at = 0n; at <= 90n; at += 10n)
		await point(
			project,
			node,
			"proc-mid",
			"cpu",
			startMid + at * second,
			Number(at),
		);
	for (let at = 0n; at <= 60n; at += 10n)
		await point(
			project,
			node,
			"proc-edge",
			"cpu",
			startEdge + at * second,
			Number(at) * 2,
		);
	const result = await run(project, {
		range: { executions: ["run:mid", "run:edge"] },
		interval: "1m",
		measures: [measures[0]],
	});
	const points = (execution: string) =>
		result.series.find((entry) => entry.execution === execution)?.points;
	// Dividing by the full minute would read 0.67 and 0.33 cores in the final buckets;
	// dividing by the time after the bucket start would read 1.33 and 20,000.
	expect(points("run:mid")).toEqual([
		{ bucketMs: 0, value: 1 },
		{ bucketMs: 60_000, value: 1 },
	]);
	expect(points("run:edge")).toEqual([
		{ bucketMs: 0, value: 2 },
		{ bucketMs: 60_000, value: 2 },
	]);
});

test("table results total each execution over its own period", async () => {
	const { project } = await seed();
	const result = await run(project, {
		shape: "table",
		interval: undefined,
		range: { executions: ["run:b", "run:a"] },
		measures: [{ ...measures[0], calculation: "increase" }],
	});
	expect(result.series.map((entry) => [entry.execution, entry.points])).toEqual(
		[
			["run:b", [{ bucketMs: null, value: 60 }]],
			["run:a", [{ bucketMs: null, value: 15 }]],
		],
	);
});

test("unknown, foreign and oversized executions fail instead of returning partial results", async () => {
	const { project, node, startA } = await seed();
	const foreign = randomUUID();
	await insertFacts([
		membership(foreign, "run:foreign", node, "proc-f", startA, startA + second),
		membership(
			project,
			"run:long",
			node,
			"proc-l",
			startA,
			startA + 7200n * second,
		),
	]);
	expect(
		await rejection(
			run(project, { range: { executions: ["run:a", "run:missing"] } }),
		),
	).toBe("NOT_FOUND");
	expect(
		await rejection(
			run(project, { range: { executions: ["run:a", "run:foreign"] } }),
		),
	).toBe("NOT_FOUND");
	// Two hours at ten-second buckets exceeds the bucket limit.
	expect(
		await rejection(run(project, { range: { executions: ["run:long"] } })),
	).toBe("INVALID_TIME_RANGE");
	expect(
		(
			await run(project, {
				range: { executions: ["run:long"] },
				interval: "1m",
			})
		).executions?.[0].execution,
	).toBe("run:long");
});
