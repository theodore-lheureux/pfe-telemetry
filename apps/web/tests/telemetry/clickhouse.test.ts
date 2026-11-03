import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { readTelemetry } from "../../src/executions/telemetry.server";

const url = process.env.TELEMETRY_CLICKHOUSE_URL;
if (!url) throw new Error("Disposable TELEMETRY_CLICKHOUSE_URL is required");
const reader = createClient({
	url,
	username: "telemetry_reader",
	password: process.env.TELEMETRY_CLICKHOUSE_READER_PASSWORD,
	database: "telemetry",
	log: { level: ClickHouseLogLevel.OFF },
});
const writer = createClient({
	url,
	username: "telemetry_writer",
	password: process.env.TELEMETRY_CLICKHOUSE_PASSWORD,
	database: "telemetry",
	clickhouse_settings: { async_insert: 0 },
	log: { level: ClickHouseLogLevel.OFF },
});
afterAll(async () => {
	await reader.close();
	await writer.close();
});

const from = new Date("2026-11-03T10:00:00Z");
const ns = BigInt(from.getTime()) * 1000000n;
function point(
	time: bigint,
	integer: string | null = "9007199254740993",
	id = "stream",
) {
	return {
		series_id: id,
		host_id: "node1",
		collection_scope: "node",
		metric: "pfe.node.memory.total",
		unit: "By",
		kind: "gauge",
		temporality: 0,
		monotonic: false,
		time_ns: time.toString(),
		start_ns: "0",
		flags: integer === null ? 1 : 0,
		integer_value: integer,
		double_value: null as number | null,
		cpu_mode: null,
	};
}
function batch(
	project: string,
	source: string,
	key: string,
	offset: number,
	points: ReturnType<typeof point>[],
) {
	return {
		project_id: project,
		source_id: source,
		storage_key: key,
		content_digest: `digest-${offset}`,
		record_id: randomUUID(),
		received_ns: ns.toString(),
		created_ns: ns.toString(),
		profile: "external/1.0",
		client_batch_id: randomUUID(),
		log_topic: "query-test",
		log_partition: 0,
		log_offset: String(offset),
		payload_hex: "",
		...Object.fromEntries(
			Object.keys(point(ns)).map((key) => [
				`points.${key}`,
				points.map((value) => value[key as keyof typeof value]),
			]),
		),
	};
}

test("deduplicates whole batches before exact nanosecond/host filters and preserves integers/nulls", async () => {
	const project = randomUUID();
	const source = randomUUID();
	const first = batch(project, source, "same-key", 1, [
		point(ns - 1n),
		point(ns),
		point(ns + 1000001n, null),
		point(ns + 1000000000n),
	]);
	const conflict = batch(project, source, "same-key", 2, [
		point(ns + 1n, "123"),
	]);
	const wrongHost = batch(project, source, "other-host", 3, [
		{ ...point(ns), host_id: "node2" },
	]);
	const outsideWinner = batch(project, source, "outside-winner", 4, [
		point(ns - 1n, "5", "outside"),
	]);
	const insideLoser = batch(project, source, "outside-winner", 5, [
		point(ns + 5n, "6", "outside"),
	]);
	await writer.insert({
		table: "batches",
		values: [
			first,
			first,
			conflict,
			wrongHost,
			outsideWinner,
			insideLoser,
			batch(randomUUID(), source, "foreign-project", 0, [point(ns, "111")]),
			batch(project, randomUUID(), "foreign-source", 0, [point(ns, "222")]),
		],
		format: "JSONEachRow",
	});
	const result = await readTelemetry(
		{
			projectId: project,
			sourceId: source,
			hostId: "node1",
			from,
			to: new Date(from.getTime() + 1000),
			buckets: 600,
		},
		undefined,
		reader,
	);
	expect(result.series).toHaveLength(1);
	expect(result.series[0].points).toEqual([
		{
			bucketMs: from.getTime(),
			timeNs: (ns + 1000001n).toString(),
			integer: null,
			double: null,
		},
	]);
	const fine = await readTelemetry(
		{
			projectId: project,
			sourceId: source,
			hostId: "node1",
			from,
			to: new Date(from.getTime() + 1),
			buckets: 1,
		},
		undefined,
		reader,
	);
	expect(fine.series[0].points).toEqual([
		{
			bucketMs: from.getTime(),
			timeNs: ns.toString(),
			integer: "9007199254740993",
			double: null,
		},
	]);
	const empty = await readTelemetry(
		{
			projectId: randomUUID(),
			sourceId: source,
			hostId: null,
			from,
			to: new Date(from.getTime() + 1),
			buckets: 1,
		},
		undefined,
		reader,
	);
	expect(empty.series).toEqual([]);
});

test("supports standard collector semantics without inferring context or merging collection profiles", async () => {
	const project = randomUUID();
	const source = randomUUID();
	const memory = point(ns, "9007199254740993", "memory");
	const cpu = {
		...point(ns, null, "cpu"),
		metric: "pfe.node.cpu.time",
		unit: "s",
		kind: "sum",
		temporality: 2,
		monotonic: true,
		double_value: 0.0004,
		flags: 0,
	};
	await writer.insert({
		table: "batches",
		format: "JSONEachRow",
		values: [
			{
				...batch(project, source, "standard", 0, [
					memory,
					cpu,
					{
						...cpu,
						series_id: "integer-cpu",
						integer_value: "9007199254740993",
						double_value: null,
					},
					{ ...point(ns, "1", "unknown"), collection_scope: "" },
					{ ...point(ns, "1", "wrong-unit"), unit: "MB" },
					{ ...point(ns, "-1", "negative") },
					{ ...cpu, series_id: "delta", temporality: 1 },
				]),
				profile: "standard",
			},
			batch(project, source, "external", 1, [memory]),
		],
	});
	const result = await readTelemetry(
		{
			projectId: project,
			sourceId: source,
			hostId: "node1",
			from,
			to: new Date(from.getTime() + 1),
			buckets: 1,
		},
		undefined,
		reader,
	);
	expect(result.series).toHaveLength(4);
	expect(new Set(result.series.map((series) => series.id)).size).toBe(4);
	expect(
		result.series.find(
			(series) =>
				series.profile === "standard" &&
				series.metric === "pfe.node.memory.total",
		)?.points[0].integer,
	).toBe("9007199254740993");
	expect(
		result.series.find((series) => series.id.endsWith(":integer-cpu"))
			?.points[0].integer,
	).toBe("9007199254740993");
	expect(
		result.series.find((series) => series.id.endsWith(":cpu"))?.points[0]
			.double,
	).toBe(0.0004);
});

test("rejects excessive series, invalid resolution and unavailable storage rather than returning no data", async () => {
	const project = randomUUID();
	const source = randomUUID();
	await writer.insert({
		table: "batches",
		values: [
			batch(
				project,
				source,
				randomUUID(),
				0,
				Array.from({ length: 25 }, (_, i) => point(ns, "1", `stream-${i}`)),
			),
		],
		format: "JSONEachRow",
	});
	const scope = {
		projectId: project,
		sourceId: source,
		hostId: null,
		from,
		to: new Date(from.getTime() + 1000),
		buckets: 10,
	};
	await expect(readTelemetry(scope, undefined, reader)).rejects.toMatchObject({
		code: "CAPACITY",
	});
	await expect(
		readTelemetry({ ...scope, buckets: 601 }, undefined, reader),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	const unavailable = createClient({
		url: "http://127.0.0.1:1",
		request_timeout: 500,
		log: { level: ClickHouseLogLevel.OFF },
	});
	try {
		await expect(
			readTelemetry(scope, undefined, unavailable),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
	} finally {
		await unavailable.close();
	}
});

test("changed Kafka provenance fails closed, and the result-row budget throws rather than truncating", async () => {
	const project = randomUUID();
	const source = randomUUID();
	const first = batch(project, source, "provenance", 0, [point(ns)]);
	await writer.insert({
		table: "batches",
		values: [first, { ...first, log_partition: 1 }],
		format: "JSONEachRow",
	});
	const scope = {
		projectId: project,
		sourceId: source,
		hostId: null,
		from,
		to: new Date(from.getTime() + 1),
		buckets: 1,
	};
	await expect(readTelemetry(scope, undefined, reader)).rejects.toMatchObject({
		code: "UNAVAILABLE",
	});
	const crowded = randomUUID();
	await writer.insert({
		table: "batches",
		values: [
			batch(
				project,
				crowded,
				"large-result",
				0,
				Array.from({ length: 14500 }, (_, i) => point(ns, "1", `series-${i}`)),
			),
		],
		format: "JSONEachRow",
	});
	await expect(
		readTelemetry({ ...scope, sourceId: crowded }, undefined, reader),
	).rejects.toMatchObject({ code: "CAPACITY" });
});
