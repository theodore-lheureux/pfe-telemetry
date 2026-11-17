import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readPoints } from "../../src/activity/points.server";
import type { AnalyticsQuery, Filter } from "../../src/analytics/contracts";
import { listAttributeValues } from "../../src/analytics/discovery.server";
import { runQuery } from "../../src/analytics/runner.server";
import { readExecutionMeasurements } from "../../src/executions/measurements.server";
import { readExecutionFacts } from "../../src/executions/participants.server";
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
const range = {
	from: from.toISOString(),
	to: new Date(from.getTime() + 60_000).toISOString(),
};
const measure = {
	name: "load",
	metric: "process.cpu.time",
	calculation: "increase",
	combine: "sum",
} as const;
const insert = (values: object[]) =>
	fixture.client.insert({
		table: "execution_participants",
		values,
		format: "JSONEachRow",
	});

function membership(
	project: string,
	node: string,
	resource: string,
	key = "run:shared",
) {
	return {
		...executionParticipant(project, key, { nodeId: node, firstSeen: ns }),
		fact_id: randomUUID(),
		kind: 2,
		process_resource_id: resource,
		process_namespace_id: "pidns:1",
		process_pid: 42,
		process_start_time_ticks: "100",
		execution_name: null,
		workload_version: null,
		parameters: [],
		last_seen_unix_nano: (ns + 20n * second).toString(),
		owner_uid: 0,
	};
}
async function point(
	project: string,
	node: string,
	resource: string,
	at: bigint,
	value: number,
	cumulative = false,
) {
	await fixture.client.command({
		query: insertPoints({
			resource_id: "{resource:String}",
			resource_kind: "toUInt8(4)",
			metric_name: "'process.cpu.time'",
			metric_kind: "toUInt8(2)",
			temporality: `toUInt8(${cumulative ? 2 : 1})`,
			monotonic: "CAST(1, 'Nullable(UInt8)')",
			unit: "'s'",
		}),
		query_params: {
			project,
			source: node,
			host: node,
			resource,
			time: (ns + at * second).toString(),
			integer: String(value),
			sample: randomUUID(),
			stream: `${node}/${resource}`,
			epoch: "epoch",
		},
	});
}
const run = (project: string, filters: Filter[] = [], groupBy: string[] = []) =>
	runQuery(
		project,
		{ shape: "table", range, measures: [measure], filters, groupBy },
		undefined,
		fixture.reader,
	);
const eq = (key = "run:shared"): Filter => ({
	field: "execution",
	op: "eq",
	values: [key],
});
const total = async (project: string, filters: Filter[] = []) =>
	(await run(project, filters)).series[0]?.points[0].value ?? null;

test("late facts, corrected times and retractions change reads without changing points or series identities", async () => {
	const project = randomUUID(),
		node = randomUUID();
	await point(project, node, "process-a", 0n, 1);
	await point(project, node, "process-a", 10n, 2);
	await point(project, node, "process-a", 20n, 4);
	await point(project, node, "process-a", 30n, 8);
	const identities = async () => {
		const result = await fixture.client.query({
			query:
				"SELECT hex(sample_id),series_id FROM metric_points FINAL WHERE project_id={project:String} ORDER BY sample_id",
			query_params: { project },
			format: "JSONEachRow",
		});
		return result.json();
	};
	const original = await identities();
	expect(await total(project, [eq()])).toBeNull();
	await insert([
		executionParticipant(project, "run:empty", { nodeId: node, firstSeen: ns }),
	]);
	expect(await total(project, [eq("run:empty")])).toBeNull();
	const fact = membership(project, node, "process-a");
	await insert([fact]);
	expect(await total(project, [eq()])).toBe(7);
	// Time predicates must not select an older revision when a correction moves it out of range.
	await insert([
		{
			...fact,
			revision: "2",
			first_seen_unix_nano: (ns + 10n * second).toString(),
			ended_unix_nano: (ns + 30n * second).toString(),
		},
		fact,
	]);
	expect(await total(project, [eq()])).toBe(6);
	await insert([
		{
			...fact,
			revision: "3",
			first_seen_unix_nano: (ns + 60n * second).toString(),
			last_seen_unix_nano: (ns + 70n * second).toString(),
		},
	]);
	expect(await total(project, [eq()])).toBeNull();
	await insert([{ ...fact, revision: "4", retracted: true }, fact]);
	expect(await total(project, [eq()])).toBeNull();
	expect(await identities()).toEqual(original);
});

test("tenant and node-qualified semijoins deduplicate overlaps and keep unassociated load visible", async () => {
	const project = randomUUID(),
		foreign = randomUUID(),
		node = randomUUID(),
		otherNode = randomUUID();
	await point(project, node, "process-a", 10n, 2);
	await point(project, node, "process-b", 10n, 5);
	await point(project, otherNode, "process-a", 10n, 11);
	await point(foreign, node, "process-a", 10n, 17);
	const fact = membership(project, node, "process-a");
	await insert([
		fact,
		fact,
		{ ...fact, fact_id: randomUUID() },
		membership(project, node, "process-a", "run:also"),
		membership(foreign, node, "process-a"),
	]);
	expect(await total(project, [eq()])).toBe(2);
	expect(await total(foreign, [eq()])).toBe(17);
	expect(
		await total(project, [
			{ field: "execution", op: "neq", values: ["run:shared"] },
		]),
	).toBe(16);
	expect(
		await total(project, [
			{ field: "execution", op: "not_in", values: ["run:shared", "run:also"] },
		]),
	).toBe(16);
	expect(
		await total(project, [
			{ field: "execution", op: "in", values: ["run:shared", "run:also"] },
		]),
	).toBe(2);
	expect(await total(project, [{ field: "execution", op: "exists" }])).toBe(2);
	expect(await total(project, [{ field: "execution", op: "not_exists" }])).toBe(
		16,
	);
	const grouped = await run(project, [], ["node", "execution"]);
	expect(
		grouped.series.map((series) => [series.group, series.points[0].value]),
	).toEqual(
		expect.arrayContaining([
			[[node, "run:shared"], 2],
			[[node, "run:also"], 2],
			[[node, null], 5],
			[[otherNode, null], 11],
		]),
	);
	expect(grouped.series).toHaveLength(4);
	expect(
		(await run(project, [eq()], ["execution"])).series.map((s) => s.group),
	).toEqual([["run:shared"]]);
	expect(
		(await run(project, [eq(), eq("run:also")], ["execution"])).series.map(
			(s) => s.group,
		),
	).toEqual(expect.arrayContaining([["run:shared"], ["run:also"]]));
	const contrast: AnalyticsQuery = {
		shape: "table",
		range,
		groupBy: ["node"],
		measures: [
			{ ...measure, name: "selected", filters: [eq()] },
			{
				...measure,
				name: "rest",
				filters: [{ field: "execution", op: "neq", values: ["run:shared"] }],
			},
		],
	};
	const result = await runQuery(project, contrast, undefined, fixture.reader);
	expect(
		result.series.map((s) => [s.measure, s.group, s.points[0].value]),
	).toEqual(
		expect.arrayContaining([
			["selected", [node], 2],
			["rest", [node], 5],
			["rest", [otherNode], 11],
		]),
	);
	const page = await readPoints(
		{
			organizationId: "organization",
			projectId: project,
			from,
			to: new Date(range.to),
			filters: [eq()],
		},
		undefined,
		fixture.reader,
	);
	expect(page.points).toHaveLength(1);
	expect(page.points[0].resourceId).toBe("process-a");
	expect(
		await listAttributeValues(fixture.reader, project, "execution", undefined),
	).toEqual(["run:also", "run:shared"]);
});

test("a second node can join late and cumulative differences remain independent for each execution group", async () => {
	const project = randomUUID(),
		node = randomUUID(),
		secondNode = randomUUID();
	for (const [at, value] of [
		[0n, 2],
		[10n, 5],
		[20n, 9],
	] as const)
		await point(project, node, "process-a", at, value, true);
	await point(project, secondNode, "process-b", 10n, 10, true);
	await point(project, secondNode, "process-b", 20n, 16, true);
	const first = membership(project, node, "process-a");
	await insert([
		first,
		{ ...first, fact_id: randomUUID() },
		{
			...membership(project, node, "process-a", "run:also"),
			first_seen_unix_nano: (ns + 10n * second).toString(),
		},
	]);
	expect(await total(project, [eq()])).toBe(7);
	await insert([membership(project, secondNode, "process-b")]);
	expect(await total(project, [eq()])).toBe(13);
	expect(
		(await run(project, [], ["execution"])).series.map((s) => [
			s.group,
			s.points[0].value,
		]),
	).toEqual(
		expect.arrayContaining([
			[["run:shared"], 13],
			[["run:also"], 4],
		]),
	);
	const limited = await runQuery(
		project,
		{
			shape: "table",
			range,
			measures: [measure],
			groupBy: ["execution"],
			limit: 1,
		},
		undefined,
		fixture.reader,
	);
	expect(limited.limited).toBe(true);
	expect(limited.series).toHaveLength(1);
});

test("execution process usage can be subtracted from node-wide load without attributing lifecycle measurements", async () => {
	const project = randomUUID(),
		node = randomUUID();
	await point(project, node, "process-a", 10n, 2);
	await insert([
		executionParticipant(project, "run:shared", {
			nodeId: node,
			firstSeen: ns,
		}),
		membership(project, node, "process-a"),
	]);
	await fixture.client.command({
		query: insertPoints({
			metric_name: "'recount.node.cpu.time'",
			metric_kind: "toUInt8(2)",
			temporality: "toUInt8(1)",
			monotonic: "CAST(1, 'Nullable(UInt8)')",
			unit: "'s'",
		}),
		query_params: {
			project,
			source: node,
			host: node,
			time: (ns + 10n * second).toString(),
			integer: "10",
			sample: randomUUID(),
			stream: "node-load",
			epoch: "epoch",
		},
	});
	const nodeMeasure = {
		...measure,
		name: "B",
		metric: "recount.node.cpu.time",
	};
	const input: AnalyticsQuery = {
		shape: "table",
		range,
		groupBy: ["node"],
		measures: [{ ...measure, name: "A", filters: [eq()] }, nodeMeasure],
		formulas: [{ name: "remaining", expression: "B - A" }],
	};
	const result = await runQuery(project, input, undefined, fixture.reader);
	expect(
		result.series.find((series) => series.measure === "remaining"),
	).toMatchObject({
		measure: "remaining",
		group: [node],
		points: [{ value: 8 }],
	});
	const attributedNode = await runQuery(
		project,
		{ shape: "table", range, measures: [nodeMeasure], filters: [eq()] },
		undefined,
		fixture.reader,
	);
	expect(attributedNode.series).toEqual([]);
});

test("execution details fail at the bounded result cap rather than returning a truncated membership list", async () => {
	const project = randomUUID();
	await insert(
		Array.from({ length: 1001 }, () => membership(project, "node", "process")),
	);
	await expect(
		readExecutionFacts(project, "run:shared", undefined, fixture.reader),
	).rejects.toMatchObject({ code: "CAPACITY" });
});

test("lifecycle-only facts never attribute measurements and detail returns latest per-node memberships and explicit ends", async () => {
	const project = randomUUID(),
		node = randomUUID();
	const lifecycle = {
		...executionParticipant(project, "run:shared", {
			nodeId: node,
			firstSeen: ns,
		}),
		ended_unix_nano: (ns + 30n * second).toString(),
	};
	await point(project, node, "process-a", 10n, 3);
	await insert([lifecycle]);
	expect(await total(project, [eq()])).toBeNull();
	const fact = {
		...membership(project, node, "process-a"),
		participant_id: lifecycle.participant_id,
	};
	await insert([
		fact,
		{ ...fact, revision: "2", ended_unix_nano: (ns + 25n * second).toString() },
		fact,
		membership(randomUUID(), node, "foreign"),
	]);
	const facts = await readExecutionFacts(
		project,
		"run:shared",
		undefined,
		fixture.reader,
	);
	expect(facts).toHaveLength(2);
	expect(facts[0]).toMatchObject({
		kind: 1,
		ended: new Date(from.getTime() + 30_000),
	});
	expect(facts[1]).toMatchObject({
		kind: 2,
		pid: 42,
		ownerUid: 0,
		ended: new Date(from.getTime() + 25_000),
	});
	await insert([{ ...fact, revision: "3", retracted: true }]);
	expect(
		await readExecutionFacts(project, "run:shared", undefined, fixture.reader),
	).toHaveLength(1);
});

test("execution measurements chart only member processes and never bridge counter segments", async () => {
	const project = randomUUID(),
		node = randomUUID(),
		otherNode = randomUUID();
	const sample = async (
		source: string,
		resource: string,
		metric: "process.cpu.time" | "recount.process.memory.rss",
		at: bigint,
		value: number,
		stream: string,
	) =>
		fixture.client.command({
			query: insertPoints(
				metric === "process.cpu.time"
					? {
							resource_id: "{resource:String}",
							resource_kind: "toUInt8(4)",
							metric_name: "'process.cpu.time'",
							metric_kind: "toUInt8(2)",
							temporality: "toUInt8(2)",
							monotonic: "CAST(1, 'Nullable(UInt8)')",
							unit: "'s'",
						}
					: {
							resource_id: "{resource:String}",
							resource_kind: "toUInt8(4)",
							metric_name: "'recount.process.memory.rss'",
							metric_kind: "toUInt8(1)",
							unit: "'By'",
						},
			),
			query_params: {
				project,
				source,
				host: source,
				resource,
				time: (ns + at * second).toString(),
				integer: String(value),
				sample: randomUUID(),
				stream,
				// A new stream stands for a new collection epoch or counter segment.
				epoch: stream,
			},
		});
	// The counter restarts at a lower value in a new segment between 10 s and 20 s.
	for (const [at, value, stream] of [
		[0n, 10, "epoch-1"],
		[10n, 20, "epoch-1"],
		[20n, 5, "epoch-2"],
		[30n, 15, "epoch-2"],
	] as const)
		await sample(node, "process-a", "process.cpu.time", at, value, stream);
	await sample(
		node,
		"process-a",
		"recount.process.memory.rss",
		10n,
		4096,
		"rss",
	);
	// Unassociated load on the same node and a member on a second node.
	await sample(node, "process-b", "process.cpu.time", 0n, 0, "other-1");
	await sample(node, "process-b", "process.cpu.time", 10n, 1000, "other-1");
	await sample(otherNode, "process-c", "process.cpu.time", 0n, 0, "second-1");
	await sample(otherNode, "process-c", "process.cpu.time", 10n, 30, "second-1");
	const facts = [
		membership(project, node, "process-a"),
		membership(project, otherNode, "process-c"),
	].map((row) => ({
		...row,
		last_seen_unix_nano: (ns + 30n * second).toString(),
	}));
	await insert(facts);
	const read = await readExecutionFacts(
		project,
		"run:shared",
		undefined,
		fixture.reader,
	);
	const result = await readExecutionMeasurements(
		project,
		"run:shared",
		read,
		undefined,
		undefined,
		fixture.reader,
	);
	if (!result) throw new Error("Expected measurements");
	// Disk I/O was never reported, so it is left out rather than failing the read.
	expect(
		result.measures.map((measure) => [measure.name, measure.unit]),
	).toEqual([
		["cpu", "s"],
		["memory", "By"],
	]);
	expect(result.bucketSeconds).toBe(2);
	const bucket = (at: bigint) => from.getTime() + Number(at) * 1000;
	const values = (measure: string, source: string) =>
		Object.fromEntries(
			(
				result.series.find(
					(series) => series.measure === measure && series.group[0] === source,
				)?.points ?? []
			).map((point) => [point.bucketMs, point.value]),
		);
	expect(values("cpu", node)).toEqual({ [bucket(10n)]: 5, [bucket(30n)]: 5 });
	expect(values("cpu", otherNode)).toEqual({ [bucket(10n)]: 15 });
	expect(values("memory", node)).toEqual({ [bucket(10n)]: 4096 });
	const selected = await readExecutionMeasurements(
		project,
		"run:shared",
		read,
		otherNode,
		undefined,
		fixture.reader,
	);
	expect([
		...new Set(selected?.series.map((series) => series.group[0])),
	]).toEqual([otherNode]);
	expect(
		await readExecutionMeasurements(
			randomUUID(),
			"run:shared",
			read,
			undefined,
			undefined,
			fixture.reader,
		),
	).toBeNull();
});
