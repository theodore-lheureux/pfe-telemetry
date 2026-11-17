import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExecutionFilters } from "../../src/executions/contracts";
import {
	FILTER_OPTION_LIMIT,
	readExecutionFilterOptions,
	readExecutions,
} from "../../src/executions/participants.server";
import { executionParticipant } from "../execution-participant";
import { createPointFixture } from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture({ participants: true });
});
afterAll(async () => {
	await fixture?.close();
});
const insert = (values: object[]) =>
	fixture.client.insert({
		table: "execution_participants",
		values,
		format: "JSONEachRow",
	});

test("execution reads join nodes, select latest revisions and apply tombstones before grouping", async () => {
	const project = randomUUID(),
		foreign = randomUUID();
	const first = executionParticipant(project, "slurm:48213");
	const second = executionParticipant(project, "slurm:48213", {
		firstSeen: BigInt(first.first_seen_unix_nano) + 1000n,
		name: "Second node",
	});
	await insert([
		first,
		first,
		second,
		executionParticipant(foreign, "slurm:48213", { name: "Foreign" }),
	]);
	const [entry] = await readExecutions(project, {}, undefined, fixture.reader);
	expect(entry).toMatchObject({
		executionKey: "slurm:48213",
		name: "Distributed job",
		nodeCount: 2,
		participantCount: 2,
		environmentVariables: ["SLURM_JOB_ID"],
		parameters: { size: "32", label: "<node>" },
	});
	expect(entry.firstSeen).toBeInstanceOf(Date);
	expect(
		(await readExecutions(foreign, {}, undefined, fixture.reader))[0].name,
	).toBe("Foreign");
	await insert([{ ...first, revision: "2", retracted: true }, first]);
	expect(
		(await readExecutions(project, {}, undefined, fixture.reader))[0],
	).toMatchObject({ name: "Second node", nodeCount: 1 });
	await insert([{ ...second, revision: "2", retracted: true }]);
	expect(await readExecutions(project, {}, undefined, fixture.reader)).toEqual(
		[],
	);
});

test("rootless lifecycles retain first-process metadata while memberships supply no root", async () => {
	const project = randomUUID();
	const lifecycle = executionParticipant(project, "run:inherited");
	const membership = {
		...lifecycle,
		fact_id: randomUUID(),
		kind: 2,
		process_resource_id: "labelled-process",
		process_namespace_id: "pidns:1",
		process_pid: 42,
		process_start_time_ticks: "100",
		execution_name: null,
		workload_version: null,
		parameters: [],
		environment_variable: "RECOUNT_EXECUTION",
	};
	await insert([lifecycle, membership]);
	const [entry] = await readExecutions(project, {}, undefined, fixture.reader);
	expect(entry).toMatchObject({
		name: "Distributed job",
		participantCount: 1,
		nodeCount: 1,
		environmentVariables: ["RECOUNT_EXECUTION", "SLURM_JOB_ID"],
	});
	await insert([{ ...lifecycle, revision: "2", retracted: true }]);
	const [withoutLifecycle] = await readExecutions(
		project,
		{},
		undefined,
		fixture.reader,
	);
	expect(withoutLifecycle).toMatchObject({
		name: "run:inherited",
		workloadVersion: null,
		parameters: {},
		environmentVariables: ["RECOUNT_EXECUTION"],
	});
});

test("execution pages use bounded project-qualified key cursors and never stamp points", async () => {
	const project = randomUUID();
	await fixture.client.command({
		query: "INSERT INTO metric_points SELECT * FROM fixture",
	});
	const identities = () =>
		fixture.client
			.query({
				query:
					"SELECT hex(sample_id),hex(stream_id),series_id FROM metric_points FINAL ORDER BY sample_id",
				format: "JSONEachRow",
			})
			.then((r) => r.json());
	const original = await identities();
	await insert(
		Array.from({ length: 53 }, (_, i) =>
			executionParticipant(project, `run:${String(i).padStart(3, "0")}`),
		),
	);
	const first = await readExecutions(project, {}, undefined, fixture.reader);
	expect(first).toHaveLength(51);
	const next = await readExecutions(
		project,
		{ afterKey: first[49].executionKey },
		undefined,
		fixture.reader,
	);
	expect(next.map((entry) => entry.executionKey)).toEqual([
		"run:050",
		"run:051",
		"run:052",
	]);
	expect(
		await readExecutions(
			project,
			{ executionKey: "missing" },
			undefined,
			fixture.reader,
		),
	).toEqual([]);
	expect(await identities()).toEqual(original);
	await expect(
		fixture.reader.command({
			query:
				"INSERT INTO execution_participants SELECT * FROM execution_participants",
		}),
	).rejects.toBeDefined();
});

const HOUR = 3_600_000_000_000n;
const T0 = 1793700000000000000n;
const at = (ns: bigint) => new Date(Number(ns / 1_000_000n));

test("execution filters match names, keys, states, machines, owners and periods after grouping", async () => {
	const project = randomUUID(),
		foreign = randomUUID();
	const [n1, n2, n3] = [randomUUID(), randomUUID(), randomUUID()].sort();
	const late = executionParticipant(project, "run:b", {
		nodeId: n3,
		name: "Beta",
		firstSeen: T0 + 2n * HOUR,
		lastSeen: T0 + 2n * HOUR,
		ownerUid: 1000,
	});
	const rootless = executionParticipant(project, "slurm:77", {
		nodeId: n1,
		name: null,
		ended: T0 + 2n * HOUR,
	});
	await insert([
		executionParticipant(project, "run:a", {
			nodeId: n1,
			name: "Alpha",
			ended: T0 + HOUR,
			ownerUid: 1000,
		}),
		executionParticipant(project, "run:b", {
			nodeId: n2,
			name: "Beta",
			firstSeen: T0 + HOUR,
			lastSeen: T0 + 2n * HOUR,
			ended: T0 + 3n * HOUR,
			ownerUid: 2000,
		}),
		late,
		rootless,
		{
			...rootless,
			fact_id: randomUUID(),
			kind: 2,
			process_resource_id: "labelled-process",
			process_namespace_id: "pidns:1",
			process_pid: 42,
			process_start_time_ticks: "100",
			execution_name: null,
			workload_version: null,
			parameters: [],
			owner_uid: 0,
		},
		executionParticipant(foreign, "run:a", { nodeId: n1, name: "Alpha" }),
	]);
	const keys = async (filters: ExecutionFilters, target = project) =>
		(await readExecutions(target, { filters }, undefined, fixture.reader)).map(
			(entry) => entry.executionKey,
		);
	const all = await readExecutions(project, {}, undefined, fixture.reader);
	expect(all).toMatchObject([
		{ executionKey: "run:a", running: false, nodeIds: [n1], ownerUids: [1000] },
		{
			executionKey: "run:b",
			running: true,
			nodeIds: [n2, n3],
			ownerUids: [1000, 2000],
		},
		{
			executionKey: "slurm:77",
			name: "slurm:77",
			running: false,
			nodeIds: [n1],
			ownerUids: [],
		},
	]);
	expect(await keys({ q: "ALP" })).toEqual(["run:a"]);
	expect(await keys({ q: "slurm:7" })).toEqual(["slurm:77"]);
	expect(await keys({ q: "%" })).toEqual([]);
	expect(await keys({ application: ["Beta", "slurm:77"] })).toEqual([
		"run:b",
		"slurm:77",
	]);
	expect(await keys({ state: "running" })).toEqual(["run:b"]);
	expect(await keys({ state: "completed" })).toEqual(["run:a", "slurm:77"]);
	expect(await keys({ machine: [n3] })).toEqual(["run:b"]);
	expect(await keys({ machine: [n1, n2] })).toEqual([
		"run:a",
		"run:b",
		"slurm:77",
	]);
	expect(await keys({ owner: [1000] })).toEqual(["run:a", "run:b"]);
	// Membership UIDs describe single processes, not the execution's owner.
	expect(await keys({ owner: [0] })).toEqual([]);
	expect(
		await keys({ from: at(T0 + HOUR / 2n), to: at(T0 + HOUR + HOUR / 2n) }),
	).toEqual(["run:b"]);
	// Last observation is inclusive and first observation is an exclusive end.
	expect(await keys({ from: at(T0 + 2n * HOUR) })).toEqual(["run:b"]);
	expect(await keys({ to: at(T0) })).toEqual([]);
	expect(await keys({ to: at(T0 + 1_000_000n) })).toEqual([
		"run:a",
		"slurm:77",
	]);
	expect(
		await keys({ application: ["Alpha"], machine: [n1], owner: [1000] }),
	).toEqual(["run:a"]);
	expect(await keys({ application: ["Alpha"] }, foreign)).toEqual(["run:a"]);
	expect(await keys({ owner: [1000] }, foreign)).toEqual([]);
	await insert([{ ...late, revision: "2", retracted: true }]);
	expect(await keys({ machine: [n3] })).toEqual([]);
	expect(await keys({ state: "running" })).toEqual([]);
	expect(await keys({ owner: [1000] })).toEqual(["run:a"]);
});

test("filtered pages keep key cursors and the one-row lookahead", async () => {
	const project = randomUUID();
	await insert(
		Array.from({ length: 110 }, (_, i) =>
			executionParticipant(project, `run:${String(i).padStart(3, "0")}`, {
				name: i % 2 ? "Odd" : "Even",
			}),
		),
	);
	const filters = { application: ["Odd"] };
	const first = await readExecutions(
		project,
		{ filters },
		undefined,
		fixture.reader,
	);
	expect(first).toHaveLength(51);
	expect(first.every((entry) => entry.name === "Odd")).toBe(true);
	expect(first[49].executionKey).toBe("run:099");
	const next = await readExecutions(
		project,
		{ afterKey: first[49].executionKey, filters },
		undefined,
		fixture.reader,
	);
	expect(next.map((entry) => entry.executionKey)).toEqual([
		"run:101",
		"run:103",
		"run:105",
		"run:107",
		"run:109",
	]);
});

test("filter options list sorted project values after retractions, within bounds", async () => {
	const project = randomUUID(),
		foreign = randomUUID();
	const [n1, n2] = [randomUUID(), randomUUID()].sort();
	const retracted = executionParticipant(project, "run:gone", {
		nodeId: randomUUID(),
		name: "Withdrawn",
		ownerUid: 7,
	});
	await insert([
		executionParticipant(project, "run:b", {
			nodeId: n2,
			name: "Beta",
			ownerUid: 1000,
		}),
		executionParticipant(project, "run:a", {
			nodeId: n1,
			name: "Alpha",
			ownerUid: 0,
		}),
		executionParticipant(project, "run:c", { nodeId: n1, name: null }),
		retracted,
		{ ...retracted, revision: "2", retracted: true },
		executionParticipant(foreign, "run:x", { name: "Foreign", ownerUid: 99 }),
	]);
	expect(
		await readExecutionFilterOptions(project, undefined, fixture.reader),
	).toEqual({
		applications: ["Alpha", "Beta", "run:c"],
		machines: [n1, n2],
		owners: [0, 1000],
	});
	expect(
		await readExecutionFilterOptions(randomUUID(), undefined, fixture.reader),
	).toEqual({ applications: [], machines: [], owners: [] });
	const crowded = randomUUID();
	const nodes = Array.from({ length: FILTER_OPTION_LIMIT + 10 }, () =>
		randomUUID(),
	);
	await insert(
		nodes.map((nodeId, i) =>
			executionParticipant(crowded, `run:${i}`, {
				nodeId,
				name: `Workload ${i}`,
				ownerUid: i,
			}),
		),
	);
	const options = await readExecutionFilterOptions(
		crowded,
		undefined,
		fixture.reader,
	);
	// The offered subset is the first values in sort order, not an arbitrary sample.
	expect(options.applications).toEqual(
		Array.from({ length: FILTER_OPTION_LIMIT + 10 }, (_, i) => `Workload ${i}`)
			.sort()
			.slice(0, FILTER_OPTION_LIMIT),
	);
	expect(options.machines).toEqual(nodes.sort().slice(0, FILTER_OPTION_LIMIT));
	expect(options.owners).toEqual(
		Array.from({ length: FILTER_OPTION_LIMIT }, (_, i) => i),
	);
});
