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
			raw_offset: "intDiv({time:UInt64}, 60000)%100 + 10",
			received_unix_nano: "{time:UInt64} * 1000000",
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
			from,
			to,
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

test("Explorer pages within one millisecond and inspects the winning receipt", async () => {
	const projectId = randomUUID();
	const timestamp = ms + MINUTE;
	await cpu(projectId, 60n, "user");
	await fixture.client.command({
		query: insertPoints(
			{
				metric_name: "'recount.node.cpu.time'",
				stream_id: "substring(SHA256(toString(intDiv(number,2))),1,16)",
				raw_offset: "number % 2",
				int_value: "toInt64(number % 2)",
				received_unix_nano: "received_unix_nano + (number % 2)",
			},
			"CROSS JOIN numbers(210) AS samples",
		),
		query_params: {
			project: projectId,
			source: "node-a",
			host: "node-a",
			time: timestamp.toString(),
			sample: "paging",
			epoch: "epoch",
		},
	});
	const filters = [
		{
			field: 'resource.attributes["recount.collection.epoch_id"]',
			op: "eq" as const,
			values: ["epoch"],
		},
	];
	const fields = ['resource.attributes["recount.collection.epoch_id"]'];
	const first = await page(projectId, { filters, fields });
	expect(first.points).toHaveLength(100);
	expect(first.nextCursor).not.toBeNull();
	const second = await page(projectId, {
		cursor: first.nextCursor ?? undefined,
		filters,
		fields,
	});
	expect(second.points).toHaveLength(5);
	expect(second.nextCursor).toBeNull();
	const points = [...first.points, ...second.points];
	expect(new Set(points.map((point) => point.sampleId)).size).toBe(105);
	expect(
		points.every(
			(point) =>
				point.timeMs === timestamp.toString() &&
				point.sampleId.length === 48 &&
				point.value === "1" &&
				point.fields[fields[0]] === "epoch",
		),
	).toBe(true);
	const [point] = second.points;
	const detail = await readPoint(
		{
			organizationId: "organization",
			projectId,
			sourceId: point.sourceId,
			resourceId: point.resourceId,
			metricName: point.metricName,
			timeMs: point.timeMs,
			sampleId: point.sampleId,
		},
		undefined,
		fixture.reader,
	);
	expect(detail.provenance.raw_offset).toBe("1");
	expect(detail.measurement.time_unix_milli).toBe(timestamp.toString());
	expect(detail.raw.stream_id).toBe(point.sampleId.slice(16));
});

test("Explorer follows receipt order across wide, late and resent deliveries", async () => {
	const project = randomUUID();
	const start = ms + MINUTE;
	const newestReceipt = (ms + 120n * MINUTE) * 1_000_000n;
	const hosts = {
		project,
		source: "node-a",
		host: "node-a",
		sample: "wide",
		epoch: "epoch",
	};
	const write = (offset: number, count: number, shifted: boolean) => {
		const time = `({time:UInt64} + number * 1500${shifted ? " + 2400000" : ""})`;
		return fixture.client.command({
			query: insertPoints(
				{
					stream_id: "substring(SHA256(toString(number)),1,16)",
					resource_id: "concat('process-',toString(number))",
					time_unix_milli: time,
					event_day: `toUInt32(intDiv(${time},86400000))`,
					min_event_unix_milli: `({time:UInt64} + ${shifted ? 2400000 : 0})`,
					max_event_unix_milli: `({time:UInt64} + ${(count - 1) * 1500 + (shifted ? 2400000 : 0)})`,
					raw_offset: "toUInt64({offset:UInt64})",
					received_unix_nano: "{received:UInt64}",
					int_value: "toInt64({offset:UInt64})",
					point_attributes: `[${stringNode("/mode", "if(number<30,'match','other')")}]`,
				},
				`CROSS JOIN numbers(${count}) AS samples`,
			),
			query_params: {
				...hosts,
				time: start.toString(),
				offset,
				received: (newestReceipt + BigInt(offset)).toString(),
			},
		});
	};
	await write(1, 30, true);
	await write(2, 1400, false);
	await write(3, 30, false);
	const first = await page(project);
	expect(first.points).toHaveLength(100);
	expect(first.points.slice(0, 30).every((point) => point.value === "3")).toBe(
		true,
	);
	expect(first.points.slice(30).every((point) => point.value === "2")).toBe(
		true,
	);
	expect(BigInt(first.points[29].timeMs)).toBeLessThan(
		BigInt(first.points[30].timeMs),
	);
	const second = await page(project, { cursor: first.nextCursor ?? undefined });
	expect(second.points).toHaveLength(100);
	expect(
		new Set(
			[...first.points, ...second.points].map(
				(point) => `${point.timeMs}/${point.sampleId}`,
			),
		).size,
	).toBe(200);
	const filtered = await page(project, {
		metric: "recount.node.memory.total",
		filters: [{ field: 'attributes["mode"]', op: "eq", values: ["match"] }],
	});
	expect(filtered.points.map((point) => point.value)).toEqual([
		...Array(30).fill("3"),
		...Array(30).fill("1"),
	]);
	expect(BigInt(filtered.points[0].timeMs)).toBeLessThan(
		BigInt(filtered.points[30].timeMs),
	);
	expect(filtered.nextCursor).toBeNull();
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
	expect(detail.provenance.raw_offset).toBe(
		((((ms + MINUTE) / MINUTE) % 100n) + 10n).toString(),
	);
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
