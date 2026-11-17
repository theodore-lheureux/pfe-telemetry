import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readExecutionLoad } from "../../src/executions/overlap-load.server";
import {
	readExecutionSpans,
	readOverlappingExecutions,
} from "../../src/executions/overlap-reads.server";
import { OVERLAP_LIMIT } from "../../src/executions/overlaps";
import { executionParticipant } from "../execution-participant";
import { createPointFixture, from, insertPoints, ns } from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture({ participants: true });
});
afterAll(async () => {
	await fixture?.close();
});
const second = 1_000_000_000n;
const at = (seconds: number) => new Date(from.getTime() + seconds * 1000);
const insert = (values: object[]) =>
	fixture.client.insert({
		table: "execution_participants",
		values,
		format: "JSONEachRow",
	});

/** A participant active from `start` through its last observation at `last`, in seconds. */
function lifecycle(
	project: string,
	key: string,
	node: string,
	start: number,
	last: number,
	options: { ended?: number; name?: string } = {},
) {
	return {
		...executionParticipant(project, key, {
			nodeId: node,
			firstSeen: ns + BigInt(start) * second,
			name: options.name,
		}),
		last_seen_unix_nano: (ns + BigInt(last) * second).toString(),
		ended_unix_nano:
			options.ended === undefined
				? null
				: (ns + BigInt(options.ended) * second).toString(),
	};
}
function membership(
	project: string,
	key: string,
	node: string,
	resource: string,
) {
	return {
		...lifecycle(project, key, node, 0, 20),
		kind: 2,
		process_resource_id: resource,
		process_namespace_id: "pidns:1",
		process_pid: 42,
		process_start_time_ticks: "100",
		execution_name: null,
		workload_version: null,
		parameters: [],
		owner_uid: 0,
	};
}
const overlaps = (project: string, key = "run:selected") =>
	readOverlappingExecutions(project, key, undefined, fixture.reader);

test("overlaps require a shared node and time within the same project, without retracted facts", async () => {
	const project = randomUUID(),
		foreign = randomUUID(),
		first = randomUUID(),
		second = randomUUID(),
		elsewhere = randomUUID();
	const retracted = lifecycle(project, "run:retracted", first, 5, 15);
	await insert([
		lifecycle(project, "run:selected", first, 0, 20),
		lifecycle(project, "run:selected", second, 0, 30, { ended: 20 }),
		lifecycle(project, "run:same-node", first, 10, 30, { name: "Later name" }),
		// The name comes from the earliest lifecycle, even on a node that is not shared.
		lifecycle(project, "run:same-node", elsewhere, 0, 1, { name: "Same node" }),
		lifecycle(project, "run:later", first, 21, 40),
		// An explicit end is exclusive, so starting at the end does not overlap.
		lifecycle(project, "run:after-end", second, 20, 40),
		lifecycle(project, "run:other-node", elsewhere, 0, 20),
		lifecycle(project, "run:both", first, 5, 6),
		lifecycle(project, "run:both", second, 15, 25),
		retracted,
		{ ...retracted, revision: "2", retracted: true },
		lifecycle(foreign, "run:foreign", first, 0, 20),
		lifecycle(foreign, "run:selected", first, 0, 20),
	]);
	const result = await overlaps(project);
	expect(result.more).toBe(false);
	expect(result.executions).toEqual([
		{
			executionKey: "run:both",
			name: "Distributed job",
			workloadVersion: "build-a",
			nodeCount: 2,
			nodeIds: [first, second].sort(),
			from: at(5),
			to: at(20),
		},
		{
			executionKey: "run:same-node",
			name: "Same node",
			workloadVersion: "build-a",
			nodeCount: 1,
			nodeIds: [first],
			from: at(10),
			to: at(20),
		},
	]);
	expect(
		(await overlaps(foreign)).executions.map((entry) => entry.executionKey),
	).toEqual(["run:foreign"]);
	expect(
		await readExecutionSpans(project, "run:missing", undefined, fixture.reader),
	).toEqual([]);
	expect(await overlaps(project, "run:missing")).toEqual({
		executions: [],
		more: false,
	});
});

test("overlaps read the project's facts in a single pass", async () => {
	const project = randomUUID(),
		node = randomUUID();
	await insert([
		lifecycle(project, "run:selected", node, 0, 100),
		...Array.from({ length: 3000 }, (_, index) =>
			lifecycle(project, `run:${index}`, randomUUID(), 0, 100),
		),
		lifecycle(project, "run:neighbour", node, 50, 60),
	]);
	const result = await fixture.client.query({
		query: "SELECT count() AS rows FROM execution_participants",
		format: "JSONEachRow",
	});
	const [{ rows }] = await result.json<{ rows: string }>();
	// Reading any share of this project's rows twice exceeds every row in the table.
	const limited = new Proxy(fixture.reader, {
		get(target, property, receiver) {
			if (property !== "query") return Reflect.get(target, property, receiver);
			return (params: Parameters<typeof target.query>[0]) =>
				target.query({
					...params,
					clickhouse_settings: {
						...params.clickhouse_settings,
						max_rows_to_read: rows,
					},
				});
		},
	});
	expect(
		(
			await readOverlappingExecutions(
				project,
				"run:selected",
				undefined,
				limited,
			)
		).executions.map((entry) => entry.executionKey),
	).toEqual(["run:neighbour"]);
});

test("overlaps are bounded with an indicator for the remainder", async () => {
	const project = randomUUID(),
		node = randomUUID();
	await insert([
		lifecycle(project, "run:selected", node, 0, 100),
		...Array.from({ length: OVERLAP_LIMIT + 2 }, (_, index) =>
			lifecycle(
				project,
				`run:${String(index).padStart(2, "0")}`,
				node,
				index,
				index + 1,
			),
		),
	]);
	const result = await overlaps(project);
	expect(result.more).toBe(true);
	expect(result.executions).toHaveLength(OVERLAP_LIMIT);
	expect(result.executions[0].executionKey).toBe("run:00");
	expect(result.executions.at(-1)?.executionKey).toBe(
		`run:${OVERLAP_LIMIT - 1}`,
	);
});

async function point(
	project: string,
	node: string,
	resource: string,
	seconds: number,
	metric: "process.cpu.time" | "recount.process.memory.rss",
	value: number,
	cumulative = false,
) {
	const cpu = metric === "process.cpu.time";
	await fixture.client.command({
		query: insertPoints({
			resource_id: "{resource:String}",
			resource_kind: "toUInt8(4)",
			metric_name: `'${metric}'`,
			metric_kind: `toUInt8(${cpu ? 2 : 1})`,
			temporality: `toUInt8(${cpu ? 1 + Number(cumulative) : 0})`,
			monotonic: cpu
				? "CAST(1, 'Nullable(UInt8)')"
				: "CAST(NULL, 'Nullable(UInt8)')",
			unit: cpu ? "'s'" : "'By'",
		}),
		query_params: {
			project,
			source: node,
			host: "shared-host",
			resource,
			time: (ns + BigInt(seconds) * second).toString(),
			integer: String(value),
			sample: randomUUID(),
			stream: `${node}/${resource}/${metric}`,
			epoch: "epoch",
		},
	});
}

test("load splits the execution's nodes between it, the project's other executions and unlabelled processes", async () => {
	const project = randomUUID(),
		foreign = randomUUID(),
		node = randomUUID(),
		elsewhere = randomUUID();
	for (const metric of [
		"process.cpu.time",
		"recount.process.memory.rss",
	] as const) {
		const scale = metric === "process.cpu.time" ? 1 : 1000;
		await point(project, node, "p-selected", 10, metric, 2 * scale);
		await point(project, node, "p-other", 10, metric, 4 * scale);
		await point(project, node, "p-free", 10, metric, 6 * scale);
		await point(project, elsewhere, "p-free", 10, metric, 100 * scale);
		// Another project's processes on the same host and resource stay invisible.
		await point(foreign, node, "p-free", 10, metric, 1000 * scale);
		await point(foreign, node, "p-selected", 10, metric, 1000 * scale);
	}
	await insert([
		membership(project, "run:selected", node, "p-selected"),
		membership(project, "run:other", node, "p-other"),
		membership(foreign, "run:selected", node, "p-free"),
	]);
	const spans = await readExecutionSpans(
		project,
		"run:selected",
		undefined,
		fixture.reader,
	);
	expect(spans).toEqual([{ nodeId: node, from: at(0), to: at(20) }]);
	const load = await readExecutionLoad(
		project,
		"run:selected",
		spans,
		undefined,
		fixture.reader,
	);
	expect(load).toMatchObject({
		from: at(0),
		to: at(22),
		bucketSeconds: 2,
		nodeCount: 1,
	});
	const values = (metric: "cpu" | "memory") =>
		Object.fromEntries(
			(load.metrics[metric]?.series ?? []).map((series) => [
				series.share,
				series.points.map((point) => [point.bucketMs, point.value]),
			]),
		);
	const bucket = at(10).getTime();
	// CPU seconds per second over the 2 s bucket: busy cores.
	expect(values("cpu")).toEqual({
		execution: [[bucket, 1]],
		others: [[bucket, 2]],
		unlabelled: [[bucket, 3]],
	});
	expect(values("memory")).toEqual({
		execution: [[bucket, 2000]],
		others: [[bucket, 4000]],
		unlabelled: [[bucket, 6000]],
	});
	expect(load.metrics.cpu).toMatchObject({ unit: "s", calculation: "rate" });
	expect(load.metrics.memory).toMatchObject({ unit: "By", calculation: "avg" });
});

test("cumulative CPU becomes per-share rates, and a process in two executions counts only as this one's", async () => {
	const project = randomUUID(),
		node = randomUUID();
	const cores = { "p-selected": 1, "p-both": 0.5, "p-other": 2, "p-free": 3 };
	for (let at = 0; at <= 20; at += 2)
		for (const [resource, rate] of Object.entries(cores))
			await point(
				project,
				node,
				resource,
				at,
				"process.cpu.time",
				at * rate,
				true,
			);
	await insert([
		membership(project, "run:selected", node, "p-selected"),
		membership(project, "run:selected", node, "p-both"),
		membership(project, "run:other", node, "p-both"),
		membership(project, "run:other", node, "p-other"),
	]);
	const spans = await readExecutionSpans(
		project,
		"run:selected",
		undefined,
		fixture.reader,
	);
	const load = await readExecutionLoad(
		project,
		"run:selected",
		spans,
		undefined,
		fixture.reader,
	);
	expect(load.metrics.memory).toBeNull();
	// The first point of each counter has no predecessor, so the first bucket is empty.
	const buckets = Array.from({ length: 10 }, (_, index) =>
		at(2 + index * 2).getTime(),
	);
	expect(
		Object.fromEntries(
			(load.metrics.cpu?.series ?? []).map((series) => [
				series.share,
				series.points,
			]),
		),
	).toEqual({
		execution: buckets.map((bucketMs) => ({ bucketMs, value: 1.5 })),
		others: buckets.map((bucketMs) => ({ bucketMs, value: 2 })),
		unlabelled: buckets.map((bucketMs) => ({ bucketMs, value: 3 })),
	});
});

test("load reports missing process metrics and refuses too many nodes", async () => {
	const project = randomUUID();
	const spans = [{ nodeId: randomUUID(), from: at(0), to: at(20) }];
	const load = await readExecutionLoad(
		project,
		"run:selected",
		spans,
		undefined,
		fixture.reader,
	);
	expect(load.metrics).toEqual({ cpu: null, memory: null });
	await expect(
		readExecutionLoad(
			project,
			"run:selected",
			Array.from({ length: 101 }, () => spans[0]),
			undefined,
			fixture.reader,
		),
	).rejects.toMatchObject({ code: "CAPACITY" });
});
