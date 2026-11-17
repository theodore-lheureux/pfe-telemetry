import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	decodeDashboardFilters,
	decodeTileOverrides,
	tileDraft,
} from "../../src/analytics/dashboard-filters";
import {
	executionContext,
	executionTemplate,
	fillTemplateVariables,
} from "../../src/analytics/dashboard-templates";
import {
	decodeDraft,
	type InsightDraft,
	toQuery,
} from "../../src/analytics/insight/draft";
import { runQuery } from "../../src/analytics/runner.server";
import source from "../../src/analytics/templates/execution.json" with {
	type: "json",
};
import {
	readExecutionFacts,
	readExecutions,
} from "../../src/executions/participants.server";
import { executionParticipant } from "../execution-participant";
import { createPointFixture, insertMetricPoint, ns } from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture({ participants: true });
});
afterAll(async () => {
	await fixture?.close();
});

const second = 1_000_000_000n;
const project = randomUUID();
const [first, second_, outside] = [randomUUID(), randomUUID(), randomUUID()];
const key = "slurm:dashboard";

const point = (
	node: string,
	metric: string,
	at: bigint,
	value: number,
	options: Omit<
		Parameters<typeof insertMetricPoint>[1],
		"project" | "node" | "metric" | "time" | "value"
	> = {},
) =>
	insertMetricPoint(fixture.client, {
		project,
		node,
		metric,
		time: ns + at * second,
		value,
		...options,
	});

function membership(node: string, resource: string) {
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

const counter = { counter: true } as const;
const read = { "disk.io.direction": "read" };
const write = { "disk.io.direction": "write" };

beforeAll(async () => {
	// Members: process-a on the first node, process-b on the second. process-c shares the
	// first node without belonging to the execution; the outside node runs none of it.
	const processes: [string, string, number[], number[]][] = [
		[first, "process-a", [1, 3, 7], [100, 300, 200]],
		[second_, "process-b", [2, 2, 6], [50, 0, 80]],
		[first, "process-c", [0, 50, 100], [10_000, 10_000, 10_000]],
	];
	for (const [node, resource, cpu, memory] of processes)
		for (const [index, at] of [0n, 10n, 20n].entries()) {
			await point(node, "process.cpu.time", at, cpu[index], {
				...counter,
				resource,
			});
			if (memory[index])
				await point(node, "recount.process.memory.rss", at, memory[index], {
					resource,
				});
		}
	for (const [node, resource, reads, writes] of [
		[first, "process-a", 1000, 500],
		[second_, "process-b", 24, 0],
		[first, "process-c", 7777, 7777],
	] as const) {
		for (const [at, factor] of [
			[0n, 0],
			[20n, 1],
		] as const) {
			await point(node, "process.disk.io", at, reads * factor, {
				...counter,
				resource,
				attributes: read,
			});
			if (writes)
				await point(node, "process.disk.io", at, writes * factor, {
					...counter,
					resource,
					attributes: write,
				});
		}
	}
	for (const [node, busy, idle, total, available, disk] of [
		[first, 10, 30, 1000, 400, 2000],
		[second_, 4, 0, 2000, 1500, 0],
		[outside, 100, 0, 4000, 0, 9999],
	] as const) {
		for (const [at, factor] of [
			[0n, 0],
			[20n, 1],
		] as const) {
			await point(node, "recount.node.cpu.time", at, busy * factor, {
				...counter,
				attributes: { "cpu.mode": "user" },
			});
			await point(node, "recount.node.cpu.time", at, idle * factor, {
				...counter,
				attributes: { "cpu.mode": "idle" },
			});
			if (disk) await point(node, "system.disk.io", at, disk * factor, counter);
		}
		await point(node, "recount.node.memory.total", 10n, total);
		await point(node, "recount.node.memory.available", 10n, available);
	}
	await fixture.client.insert({
		table: "execution_participants",
		values: [
			executionParticipant(project, key, { nodeId: first, firstSeen: ns }),
			membership(first, "process-a"),
			membership(second_, "process-b"),
		],
		format: "JSONEachRow",
	});
});

async function dashboard() {
	const [entry] = await readExecutions(
		project,
		{ executionKey: key },
		undefined,
		fixture.reader,
	);
	const facts = await readExecutionFacts(
		project,
		key,
		undefined,
		fixture.reader,
	);
	const template = fillTemplateVariables(
		executionTemplate(),
		{ $execution: key },
		executionContext({ ...entry, facts }),
	);
	const filters = decodeDashboardFilters(template.filters);
	if (!filters) throw new Error("Unreadable dashboard filters");
	return template.tiles.map((tile) => ({
		name: tile.insight.name,
		draft: tileDraft(
			decodeDraft(tile.insight.draft),
			filters,
			decodeTileOverrides(tile.overrides),
		),
	}));
}

async function run(draft: InsightDraft) {
	const query = toQuery(draft, new Date(), "UTC", "en");
	if (!query) throw new Error("Incomplete draft");
	return runQuery(project, query, undefined, fixture.reader);
}

/** The draft's one value per group over its whole range, as its table view shows it. */
async function totals(draft: InsightDraft) {
	const result = await run({
		...draft,
		display: { ...draft.display, type: "table" },
	});
	return Object.fromEntries(
		result.series.map((series) => [
			series.group[0] ?? "",
			series.points[0]?.value,
		]),
	);
}

test("the execution dashboard reads the execution's period, its processes and their nodes", async () => {
	const tiles = await dashboard();
	// The period in whole minutes: 10:00 to 10:01.
	const seconds = 60;
	expect(tiles).toHaveLength(12);
	const [cpuTime, peakMemory, diskRead, diskWritten] = tiles;
	// Totals over the execution's period, excluding the unrelated process on a member node.
	for (const [tile, expected] of [
		[cpuTime, 10],
		[peakMemory, 380],
		[diskRead, 1024],
		[diskWritten, 500],
	] as const) {
		const result = await run(tile.draft);
		expect(result.shape).toBe("table");
		expect(result.series).toHaveLength(1);
		expect(result.series[0].points[0].value).toBe(expected);
	}
	const named = (suffix: string) => {
		const index = source.tiles.findIndex(
			(tile) => tile.insight.name === `dashboard_template_execution_${suffix}`,
		);
		if (index < 0) throw new Error(`Missing ${suffix}`);
		return tiles[index].draft;
	};
	const cpu = await totals(named("cpu"));
	expect(Object.keys(cpu).sort()).toEqual([first, second_].sort());
	expect(cpu[first]).toBeCloseTo(6 / seconds, 9);
	expect(cpu[second_]).toBeCloseTo(4 / seconds, 9);
	expect(Object.keys(await totals(named("memory"))).sort()).toEqual(
		[first, second_].sort(),
	);
	const disk = await totals(named("disk"));
	expect(disk[first]).toBeCloseTo(1500 / seconds, 9);
	expect(disk[second_]).toBeCloseTo(24 / seconds, 9);
	// Node context ignores the execution filter but stays on the execution's nodes.
	const nodeCpu = await totals(named("node_cpu"));
	expect(Object.keys(nodeCpu).sort()).toEqual([first, second_].sort());
	expect(nodeCpu[first]).toBeCloseTo(10 / seconds, 9);
	expect(await totals(named("node_memory"))).toEqual({
		[first]: 600,
		[second_]: 500,
	});
	expect(Object.keys(await totals(named("node_disk")))).toEqual([first]);
	// The cluster includes every node.
	expect((await totals(named("cluster_cpu")))[""]).toBeCloseTo(
		114 / seconds,
		9,
	);
	expect(await totals(named("cluster_memory"))).toEqual({ "": 5100 });
	// The charts themselves run as timeseries over the same period.
	for (const tile of tiles.slice(4)) {
		const result = await run(tile.draft);
		expect(result.shape).toBe("timeseries");
		expect(result.from.getTime()).toBe(Number(ns / 1_000_000n));
		expect(result.to.getTime()).toBe(Number(ns / 1_000_000n) + 60_000);
		expect(result.series.length).toBeGreaterThan(0);
	}
});
