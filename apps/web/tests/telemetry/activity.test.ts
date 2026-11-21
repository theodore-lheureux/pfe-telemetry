import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readPoint, readPoints } from "../../src/activity/points.server";
import {
	createPointFixture,
	from,
	insertPoints,
	ms,
	stringNode,
} from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture();
});
afterAll(async () => {
	await fixture?.close();
});

const MINUTE = 60_000n;

async function cpu(
	project: string,
	at: bigint,
	mode: string,
	sample: string = randomUUID(),
) {
	await fixture.client.command({
		query: insertPoints({
			metric_name: "'recount.node.cpu.time'",
			metric_kind: "toUInt8(2)",
			int_value: "CAST(NULL, 'Nullable(Int64)')",
			double_value: "CAST(1, 'Nullable(Float64)')",
			point_attributes: `[${stringNode("/cpu.mode", "{mode:String}")}]`,
		}),
		query_params: {
			project,
			source: "node-a",
			host: "node-a",
			time: (ms + at * MINUTE).toString(),
			integer: null as unknown as string,
			mode,
			sample,
			stream: `node-a/cpu/${mode}`,
			epoch: "epoch",
		},
	});
}

// Reads the hour after the fixture's start, as a page cursor would.
const page = (
	project: string,
	options: Parameters<typeof readPoints>[0] extends infer I
		? Partial<I>
		: never = {},
) => {
	const to = new Date(from.getTime() + 3_600_000);
	return readPoints(
		{
			organizationId: "organization",
			projectId: project,
			filters: [],
			cursor: {
				from,
				to,
				timeMs: BigInt(to.getTime()).toString(),
				sampleId: "FF".repeat(24),
			},
			...options,
		},
		undefined,
		fixture.reader,
	);
};

test("Explorer filters by metric and attributes and searches past empty windows", async () => {
	const project = randomUUID();
	// Points only in the first minutes, so the newest windows of the hour are empty.
	await cpu(project, 1n, "user");
	await cpu(project, 2n, "system");
	const resent = randomUUID();
	await cpu(project, 3n, "idle", resent);
	// Merges are stopped, so the resent copy stays until the page removes it.
	await cpu(project, 3n, "idle", resent);
	const all = await page(project);
	expect(all.points.map((point) => point.metricName)).toEqual([
		"recount.node.cpu.time",
		"recount.node.cpu.time",
		"recount.node.cpu.time",
	]);
	expect(all.nextCursor).toBeNull();
	const user = await page(project, {
		metric: "recount.node.cpu.time",
		filters: [{ field: 'attributes["cpu.mode"]', op: "eq", values: ["user"] }],
	});
	expect(user.points).toHaveLength(1);
	const busy = await page(project, {
		filters: [{ field: 'attributes["cpu.mode"]', op: "neq", values: ["idle"] }],
	});
	expect(busy.points).toHaveLength(2);
	expect(
		(await page(project, { metric: "recount.node.memory.total" })).points,
	).toHaveLength(0);
	expect(
		(
			await page(project, {
				filters: [{ field: 'attributes["cpu.mode"]', op: "not_exists" }],
			})
		).points,
	).toHaveLength(0);
	expect((await page(randomUUID())).points).toHaveLength(0);
	// Attribute columns come back as text, or null for points without them.
	const projected = await page(project, {
		fields: ['attributes["cpu.mode"]', 'resource.attributes["missing"]'],
	});
	expect(
		projected.points.map((point) => point.fields['attributes["cpu.mode"]']),
	).toEqual(["idle", "system", "user"]);
	expect(
		projected.points[0]?.fields['resource.attributes["missing"]'],
	).toBeNull();
});

test("inspector restores request provenance from a compact delivery", async () => {
	const projectId = randomUUID();
	await cpu(projectId, 1n, "user");
	const [point] = (await page(projectId)).points;
	const input = {
		projectId,
		organizationId: "organization",
		sourceId: point.sourceId,
		resourceId: point.resourceId,
		metricName: point.metricName,
		timeMs: point.timeMs,
		sampleId: point.sampleId,
	};
	const detail = await readPoint(input, undefined, fixture.reader);
	expect(detail.provenance.record_id).toBeTruthy();
	expect(detail.provenance.payload_kind).toBe("OTLP_METRICS");
	expect(detail.provenance.original).toBeDefined();
	expect(detail.provenance.access).toBeDefined();
	expect(detail.provenance.raw_offset).toBe("0");
	expect(typeof detail.provenance.oldest_collection_delay_ns).toBe("string");
	expect(detail.raw.lineage).toEqual(detail.provenance);
	await fixture.client.command({
		query:
			"ALTER TABLE delivery_contexts DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 2",
		query_params: { project: projectId },
	});
	await expect(
		readPoint(input, undefined, fixture.reader),
	).rejects.toMatchObject({
		code: "UNAVAILABLE",
		message: "Measurement provenance is not yet available",
	});
	await fixture.client.command({
		query:
			"ALTER TABLE metric_streams DELETE WHERE project_id = {project:String} SETTINGS mutations_sync = 2",
		query_params: { project: projectId },
	});
	await expect(
		readPoint(input, undefined, fixture.reader),
	).rejects.toMatchObject({
		code: "UNAVAILABLE",
		message: "Measurement continuity is not yet available",
	});
});
