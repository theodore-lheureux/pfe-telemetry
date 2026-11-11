import { expect, test } from "bun:test";
import type { Kafka } from "kafkajs";
import { Root } from "protobufjs/light";
import { decodeNotification, liveShard } from "../../src/activity/codec.server";
import generated from "../../src/activity/generated/descriptors.json";
import { ownLiveConnection } from "../../src/activity/live-connection.server";
import {
	LiveHub,
	type ShardTransport,
} from "../../src/activity/live-hub.server";
import { readRawPacket } from "../../src/activity/live-kafka.server";
import { parseLiveEvent } from "../../src/activity/live-state";
import { activityStream } from "../../src/activity/live-stream.server";
import { sseChannel } from "../../src/activity/sse.server";
import { parsePacket } from "../../src/activity/validation";
import { OperationError } from "../../src/lib/operation-error";

const projectId = "019a4790-d1da-7000-8000-000000000002";
const notification = Root.fromJSON(generated.schema).lookupType(
	"recount.telemetry.LiveNotification",
);
function event(project = projectId) {
	return decodeNotification(
		Buffer.from(
			notification
				.encode(
					notification.fromObject({
						project_id: project,
						source_id: "source",
						record_id: crypto.randomUUID(),
						received_unix_nano: "1794300000000000000",
						measured_unix_nano: "1794300000000000000",
						nodes: [
							{
								id: "node",
								name: "test node",
								measured_unix_nano: "1794300000000000000",
							},
						],
						resources: 1,
						metrics: 2,
						points: 300,
						bytes: 100000,
						raw_partition: 0,
						raw_offset: "9007199254740993",
					}),
				)
				.finish(),
		),
	);
}

test("notifications contain summaries and exact raw references, never a payload", () => {
	const value = event();
	expect(value.summary).toMatchObject({
		points: 300,
		metrics: 2,
		partition: 0,
		offset: "9007199254740993",
	});
	expect(value.summary.receivedAt).toBeInstanceOf(Date);
	expect(value).not.toHaveProperty("payload");
	expect(value).not.toHaveProperty("delivery");
	expect(liveShard(projectId, 8)).toBe(5);
	expect(
		parseLiveEvent(JSON.stringify(value), projectId).summary.receivedAt,
	).toEqual(value.summary.receivedAt);
	expect(() =>
		parseLiveEvent(JSON.stringify(value), "another-project"),
	).toThrow();
	expect(() => decodeNotification(Buffer.alloc(32769))).toThrow();
	const reference = {
		organizationId: "org",
		projectId,
		packetId: "packet",
		partition: 0,
		offset: "9007199254740993",
	};
	expect(parsePacket(reference).offset).toBe(reference.offset);
	for (const offset of ["-1", "1.2", "9223372036854775808", "01", 1])
		expect(() => parsePacket({ ...reference, offset })).toThrow();
});

test("active viewers share a shard, receive no earlier offsets or other projects, and release the reader", async () => {
	let starts = 0,
		stops = 0,
		end = "10";
	let deliver: Parameters<ShardTransport["start"]>[3] = () => {};
	const hub = new LiveHub({
		end: async () => end,
		start: (_id, from, _signal, receive) => {
			expect(from).toBe("10");
			starts++;
			deliver = receive;
			return {
				ready: Promise.resolve(),
				close: async () => {
					stops++;
				},
			};
		},
	});
	const first: string[] = [],
		second: string[] = [];
	const abort = new AbortController();
	const offFirst = await hub.subscribe(
		1,
		projectId,
		abort.signal,
		(e) => first.push(e.summary.id),
		() => {},
	);
	const packet = event();
	deliver("9", packet);
	deliver("10", event("019a4790-d1da-7000-8000-000000000003"));
	expect(first).toHaveLength(0);
	deliver("10", packet);
	end = "12";
	const offSecond = await hub.subscribe(
		1,
		projectId,
		abort.signal,
		(e) => second.push(e.summary.id),
		() => {},
	);
	deliver("11", packet);
	expect(first).toHaveLength(2);
	expect(second).toHaveLength(0);
	deliver("12", packet);
	expect(second).toHaveLength(1);
	expect(starts).toBe(1);
	offFirst();
	expect(stops).toBe(0);
	offSecond();
	await hub.close();
	expect(stops).toBe(1);
});

test("aborting during startup waits for owned startup disposal and shuts down once", async () => {
	let release = () => {},
		closes = 0;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	const hub = new LiveHub({
		end: async () => "0",
		start: (_shard, _from, signal) =>
			ownLiveConnection(
				signal,
				() => ready,
				async () => {
					closes++;
				},
			),
	});
	const abort = new AbortController();
	const subscription = hub.subscribe(
		0,
		projectId,
		abort.signal,
		() => {},
		() => {},
	);
	void subscription.catch(() => {});
	await Promise.resolve();
	abort.abort();
	const shutdown = hub.close();
	expect(closes).toBe(0);
	release();
	await expect(subscription).rejects.toThrow();
	await shutdown;
	expect(closes).toBe(1);
});

test("SSE closes slow clients at the byte ceiling without retaining packet history", async () => {
	let disposed = 0;
	const abort = new AbortController();
	const channel = sseChannel(abort.signal, () => {
		disposed++;
	});
	expect(channel.send("packet", { value: "x".repeat(40000) })).toBe(true);
	expect(channel.send("packet", { value: "x".repeat(40000) })).toBe(false);
	expect(disposed).toBe(1);
	abort.abort();
	expect(disposed).toBe(1);
	const text = await new Response(channel.body).text();
	expect(text).toContain("event: packet\n");
	expect(text).not.toContain("id:");
});

test("startup cancellation rejects readiness before late initialization is disposed", async () => {
	let release = () => {},
		disposed = 0;
	const startup = new Promise<void>((resolve) => {
		release = resolve;
	});
	const abort = new AbortController();
	const connection = ownLiveConnection(
		abort.signal,
		() => startup,
		async () => {
			disposed++;
		},
	);
	await Promise.resolve();
	abort.abort();
	await expect(connection.ready).rejects.toThrow("cancelled");
	expect(disposed).toBe(0);
	release();
	await connection.close();
	expect(disposed).toBe(1);
});

test("packet cancellation completes promptly while the reader reservation owns late disposal", async () => {
	let release = () => {},
		disposed = 0;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const consumer = {
		events: { GROUP_JOIN: "joined", CRASH: "crash" },
		on() {},
		connect: () => pending,
		subscribe: async () => {
			throw new Error("Cancelled startup must not subscribe");
		},
		stop: async () => {},
		disconnect: async () => {
			disposed++;
		},
	};
	const kafka = { consumer: () => consumer } as unknown as Kafka;
	const abort = new AbortController();
	const read = readRawPacket(
		kafka,
		{
			organizationId: "org",
			projectId,
			packetId: "packet",
			partition: 0,
			offset: "1",
		},
		abort.signal,
		"test.raw",
	);
	await Promise.resolve();
	abort.abort();
	await expect(read.result).rejects.toThrow();
	expect(disposed).toBe(0);
	release();
	await read.closed;
	expect(disposed).toBe(1);
});

test("SSE authorizes before opening the gateway and emits explicit access failures", async () => {
	let opened = false;
	const response = await activityStream(
		new Request("http://localhost/api/activity/live"),
		async () => {
			throw new OperationError("NOT_FOUND", "Project unavailable");
		},
		async () => {
			opened = true;
			return new Response();
		},
	);
	expect(await response.text()).toContain('"code":"NOT_FOUND"');
	expect(opened).toBe(false);
});

test("SSE reauthorization stops a split private frame before forwarding any of it", async () => {
	let now = 0,
		revoked = false,
		cancelled = false;
	let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const encode = (text: string) => new TextEncoder().encode(text);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			upstream = controller;
			controller.enqueue(
				encode(
					'event: connected\ndata: {}\n\nevent: packet\ndata: {"private":',
				),
			);
		},
		cancel() {
			cancelled = true;
		},
	});
	const response = await activityStream(
		new Request("http://localhost/api/activity/live"),
		async () => {
			if (revoked) throw new OperationError("FORBIDDEN", "Access revoked");
		},
		async () => new Response(body),
		() => now,
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	expect(new TextDecoder().decode((await reader.read()).value)).toContain(
		"event: connected",
	);
	now = 10000;
	revoked = true;
	if (!upstream) throw new Error("Missing upstream controller");
	upstream.enqueue(encode('"secret"}\n\n'));
	const failure = new TextDecoder().decode((await reader.read()).value);
	expect(failure).toContain('"code":"FORBIDDEN"');
	expect(failure).not.toContain("private");
	expect((await reader.read()).done).toBe(true);
	expect(cancelled).toBe(true);
});
