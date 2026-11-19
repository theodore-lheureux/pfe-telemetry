import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readExecutions } from "../../src/executions/participants.server";
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
		query: "INSERT INTO fixture_input SELECT * FROM fixture",
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
