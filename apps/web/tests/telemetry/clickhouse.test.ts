import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ClickHouseLogLevel, createClient } from "@clickhouse/client";
import { readTelemetry } from "../../src/executions/telemetry.server";
import {
	createPointFixture,
	from,
	insertPoints,
	ns,
	scope,
	stringNode,
} from "./fixture";

let fixture: Awaited<ReturnType<typeof createPointFixture>>;
beforeAll(async () => {
	fixture = await createPointFixture();
});
afterAll(async () => {
	await fixture?.close();
});

async function seed(
	project: string,
	source: string,
	options: {
		host?: string;
		time?: bigint;
		integer?: string | null;
		sample?: string;
		stream?: string;
		epoch?: string;
		replace?: Record<string, string>;
	} = {},
) {
	await fixture.client.command({
		query: insertPoints(options.replace),
		query_params: {
			project,
			source,
			host: options.host ?? "node1",
			time: (options.time ?? ns).toString(),
			integer:
				options.integer === undefined ? "9007199254740993" : options.integer,
			sample: options.sample ?? randomUUID(),
			stream: options.stream ?? "memory",
			epoch: options.epoch ?? "epoch",
		},
	});
}
const read = (s: ReturnType<typeof scope>) =>
	readTelemetry(s, undefined, fixture.client);

test("exact nanoseconds, no-recorded flags, tenant/source/host filters and replay without merges", async () => {
	const project = randomUUID(),
		source = randomUUID(),
		sample = randomUUID();
	await seed(project, source, { sample });
	const exact = await read(scope(project, source, "node1", 1));
	expect(exact.series[0].segments[0].points[0]).toEqual({
		bucketMs: from.getTime(),
		timeNs: ns.toString(),
		integer: "9007199254740993",
		double: null,
		flags: 0,
	});
	await seed(project, source, { sample });
	await seed(project, source, { sample });
	expect(await read(scope(project, source, "node1", 1))).toEqual(exact);
	await seed(project, source, {
		time: ns + 1000001n,
		integer: "9223372036854775807",
		replace: { flags: "toUInt32(3)" },
	});
	await seed(project, source, { time: ns - 1n, integer: "5" });
	await seed(project, source, { host: "node2", integer: "7" });
	await seed(randomUUID(), source);
	await seed(project, randomUUID());
	const result = await read(scope(project, source));
	expect(result.series).toHaveLength(1);
	expect(result.series[0].segments[0].points).toEqual([
		{
			bucketMs: from.getTime(),
			timeNs: (ns + 1000001n).toString(),
			integer: null,
			double: null,
			flags: 3,
		},
	]);
	expect((await read(scope(randomUUID(), source))).series).toEqual([]);
	expect(
		(await read(scope(project, source, "node2"))).series[0].segments[0]
			.points[0].integer,
	).toBe("7");
});

test("only explicit typed node resources and recognized nonnegative scalar semantics chart", async () => {
	const project = randomUUID(),
		source = randomUUID();
	for (const replace of [
		{ resource_kind: "toUInt8(4)" },
		{ resource_attributes: "[]" },
		{
			resource_attributes: `[${stringNode("/recount.collection.scope", "'process'")}]`,
		},
		{
			metric_kind: "toUInt8(2)",
			temporality: "toUInt8(1)",
			monotonic: "toUInt8(1)",
			metric_name: "'recount.node.cpu.time'",
			unit: "'s'",
		},
		{ int_value: "toInt64('-9223372036854775808')" },
		{ unit: "'1'" },
		{ metric_name: "'arbitrary.metric'" },
	] as Record<string, string>[])
		await seed(project, source, { replace });
	expect((await read(scope(project, source))).series).toEqual([]);
	await seed(project, source, { integer: "9223372036854775807" });
	expect(
		(await read(scope(project, source))).series[0].segments[0].points[0]
			.integer,
	).toBe("9223372036854775807");
	const floats = randomUUID();
	await seed(project, floats, {
		replace: {
			int_value: "NULL",
			double_value: "toFloat64(1.2345678901234567)",
		},
	});
	expect(
		(await read(scope(project, floats))).series[0].segments[0].points[0].double,
	).toBe(1.2345678901234567);
});

test("two hosts and three epochs retain18 logical groups and54 restart segments", async () => {
	const project = randomUUID(),
		source = randomUUID();
	for (const host of ["node1", "node2"])
		for (let epoch = 0; epoch < 3; epoch++)
			for (let metric = 0; metric < 9; metric++)
				for (let tick = 0; tick < 3; tick++) {
					const cpu = metric < 7;
					await seed(project, source, {
						host,
						epoch: `epoch${epoch}`,
						stream: `${host}/${metric}/${epoch}`,
						time: ns + BigInt(epoch * 10000 + tick * 1000) * 1000000n,
						replace: cpu
							? {
									metric_name: "'recount.node.cpu.time'",
									unit: "'s'",
									metric_kind: "toUInt8(2)",
									temporality: "toUInt8(2)",
									monotonic: "toUInt8(1)",
									start_time_unix_nano: String(ns + BigInt(epoch)),
									int_value: "NULL",
									double_value: String(epoch === 1 ? tick : 100 + tick),
									point_attributes: `[${stringNode("/cpu.mode", `'mode${metric}'`)},${stringNode("/recount.counter.segment_id", "{epoch:String}")}]`,
								}
							: {
									metric_name:
										metric === 7
											? "'recount.node.memory.total'"
											: "'recount.node.memory.available'",
								},
					});
				}
	const result = await read({
		...scope(project, source, null, 60000),
		buckets: 60,
	});
	expect(result.series).toHaveLength(18);
	expect(result.series.reduce((n, s) => n + s.segments.length, 0)).toBe(54);
	expect(
		result.series
			.flatMap((s) => s.segments)
			.every((s) => s.points.length === 3),
	).toBe(true);
	const isolated = await read({
		...scope(project, source, "node2", 60000),
		buckets: 60,
	});
	expect(isolated.series).toHaveLength(9);
	expect(isolated.series.every((s) => s.hostId === "node2")).toBe(true);
});

test("actual typed dimensions, instrumentation providers and schemas never merge", async () => {
	const project = randomUUID(),
		source = randomUUID();
	for (const replace of [
		{},
		{ scope_name: "'other.provider'" },
		{ scope_version: "'different'" },
		{ resource_schema_url: "'https://example.invalid/resource'" },
		{ scope_schema_url: "'https://example.invalid/scope'" },
		{ resource_id: "'another-enrolled-resource'" },
		{
			point_attributes: `[tuple('/dimension',toUInt8(3),NULL,toInt64(1),NULL,NULL,NULL)]`,
		},
		{ point_attributes: `[${stringNode("/dimension", "'1'")}]` },
	] as Record<string, string>[])
		await seed(project, source, { replace });
	expect((await read(scope(project, source))).series).toHaveLength(8);
});

test("attribute map order is canonical while Float64 dimension bits remain distinct", async () => {
	const project = randomUUID(),
		source = randomUUID();
	const a = stringNode("/a", "'first'"),
		b = stringNode("/b", "'second'");
	for (const attributes of [`[${a},${b}]`, `[${b},${a}]`])
		await seed(project, source, { replace: { point_attributes: attributes } });
	expect((await read(scope(project, source))).series).toHaveLength(1);
	const bits = randomUUID();
	for (const value of [
		"toFloat64(0)",
		"reinterpretAsFloat64(toUInt64('9223372036854775808'))",
	])
		await seed(project, bits, {
			replace: {
				point_attributes: `[tuple('/zero',toUInt8(4),NULL,NULL,${value},NULL,NULL)]`,
			},
		});
	expect((await read(scope(project, bits))).series).toHaveLength(2);
});

test("a real SELECT-only reader supports concurrent reads but cannot write or inspect the seed table", async () => {
	const project = randomUUID(),
		source = randomUUID();
	await seed(project, source);
	const expected = await read(scope(project, source));
	const pending = Promise.all(
		Array.from({ length: 2 }, () =>
			readTelemetry(scope(project, source), undefined, fixture.reader),
		),
	);
	const [results] = await Promise.all([
		pending,
		expect(
			readTelemetry(scope(project, source), undefined, fixture.reader),
		).rejects.toMatchObject({ code: "CAPACITY" }),
	]);
	for (const result of results) expect(result).toEqual(expected);
	for (const query of [
		"INSERT INTO metric_points SELECT * FROM metric_points",
		"ALTER TABLE metric_points DELETE WHERE 1",
		"DROP TABLE metric_points",
		"CREATE TABLE denied (id UInt8) ENGINE=Memory",
	])
		await expect(fixture.reader.command({ query })).rejects.toMatchObject({
			code: "497",
		});
	await expect(
		fixture.reader.query({
			query: "SELECT * FROM fixture",
			format: "JSONEachRow",
		}),
	).rejects.toMatchObject({ code: "497" });
	expect(
		await readTelemetry(scope(project, source), undefined, fixture.reader),
	).toEqual(expected);
});

test("partial visibility is available; missing storage and cancellation are not empty success", async () => {
	const project = randomUUID(),
		source = randomUUID();
	await seed(project, source);
	expect((await read(scope(project, source))).series).toHaveLength(1);
	const unavailable = createClient({
		url: "http://127.0.0.1:1",
		request_timeout: 500,
		log: { level: ClickHouseLogLevel.OFF },
	});
	try {
		await expect(
			readTelemetry(scope(randomUUID(), source), undefined, unavailable),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await expect(
			readTelemetry(
				scope(project, source),
				AbortSignal.abort(),
				fixture.client,
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
	} finally {
		await unavailable.close();
	}
	const password = process.env.RECOUNT_CLICKHOUSE_TEST_READER_PASSWORD;
	if (!password)
		throw new Error("Synthetic SELECT-only test reader password required");
	const denied = fixture.createConnection({
		username: "telemetry_reader",
		password,
	});
	try {
		// The allocated reader has no grant on this randomly named test database.
		await expect(
			denied.query({
				query: "SELECT count() FROM metric_points",
				format: "JSONEachRow",
			}),
		).rejects.toMatchObject({ code: "497" });
		await expect(
			readTelemetry(scope(project, source), undefined, denied),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
		const controller = new AbortController();
		const pending = readTelemetry(
			scope(project, source),
			controller.signal,
			fixture.client,
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
	} finally {
		await denied.close();
	}
});

test("range and logical group limits fail rather than truncate", async () => {
	const project = randomUUID(),
		source = randomUUID();
	await expect(
		read({ ...scope(project, source), buckets: 601 }),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	await expect(
		read(scope(project, source, null, 86400001)),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	for (let i = 0; i < 25; i++)
		await seed(project, source, { replace: { scope_name: `'provider${i}'` } });
	await expect(read(scope(project, source))).rejects.toMatchObject({
		code: "CAPACITY",
	});
});

test("continuity segment and physical point limits fail rather than truncate", async () => {
	const project = randomUUID(),
		source = randomUUID();
	await fixture.client.command({
		query: insertPoints(
			{
				sample_id: "SHA256(toString(number))",
				stream_id: "SHA256(toString(number))",
			},
			"CROSS JOIN numbers(257) AS ticks",
		),
		query_params: {
			project,
			source,
			host: "node1",
			sample: "unused",
			stream: "unused",
			epoch: "epoch",
			integer: "1",
			time: ns.toString(),
		},
	});
	await expect(read(scope(project, source))).rejects.toMatchObject({
		code: "CAPACITY",
	});
	const crowded = randomUUID();
	for (let offset = 0; offset < 100001; offset += 4096)
		await fixture.client.command({
			query: insertPoints(
				{ sample_id: "SHA256(toString(number))" },
				`CROSS JOIN numbers(${offset},${Math.min(4096, 100001 - offset)}) AS ticks`,
			),
			query_params: {
				project: crowded,
				source,
				host: "node1",
				sample: "unused",
				stream: "stream",
				epoch: "epoch",
				integer: "1",
				time: ns.toString(),
			},
			clickhouse_settings: {
				max_threads: 1,
				max_memory_usage: "268435456",
				max_block_size: "4096",
				max_insert_block_size: "4096",
			},
		});
	await expect(read(scope(crowded, source))).rejects.toMatchObject({
		code: "CAPACITY",
	});
});
