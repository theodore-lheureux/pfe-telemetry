import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { Root } from "protobufjs/light";
import { liveShard } from "../../src/activity/codec.server";
import generated from "../../src/activity/generated/descriptors.json";
import { createLiveGateway } from "../../src/activity/live-gateway.server";

const enabled = process.env.RECOUNT_ACTIVITY_TEST_ALLOW_PUBLISH === "1";
const root = Root.fromJSON(generated.schema);
const rawType = root.lookupType("recount.telemetry.RawRecord");
const notificationType = root.lookupType("recount.telemetry.LiveNotification");
const otlpType = root.lookupType(
	"opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);

test.skipIf(!enabled)(
	"shared Live gateway tails active shards, isolates projects and inspects retained packets after restart",
	async () => {
		const brokers = process.env.RECOUNT_ACTIVITY_KAFKA_BROKERS?.split(",");
		if (!brokers?.length)
			throw new Error("Explicit reused Kafka endpoint required");
		const prefix = `recount.test.activity.${randomUUID()}`;
		const topic = `${prefix}.live`,
			rawTopic = `${prefix}.raw`;
		const saved = {
			RECOUNT_LIVE_TOPIC: process.env.RECOUNT_LIVE_TOPIC,
			RECOUNT_RAW_TOPIC: process.env.RECOUNT_RAW_TOPIC,
			RECOUNT_LIVE_PARTITIONS: process.env.RECOUNT_LIVE_PARTITIONS,
			RECOUNT_LIVE_GATEWAY_SECRET: process.env.RECOUNT_LIVE_GATEWAY_SECRET,
		};
		Object.assign(process.env, {
			RECOUNT_LIVE_TOPIC: topic,
			RECOUNT_RAW_TOPIC: rawTopic,
			RECOUNT_LIVE_PARTITIONS: "2",
			RECOUNT_LIVE_GATEWAY_SECRET: randomUUID(),
		});
		const headers = {
			Authorization: `Bearer ${process.env.RECOUNT_LIVE_GATEWAY_SECRET}`,
		};
		const kafka = new Kafka({
			brokers,
			clientId: prefix,
			logLevel: logLevel.NOTHING,
		});
		const admin = kafka.admin(),
			producer = kafka.producer();
		const projectId = randomUUID();
		let other = randomUUID();
		while (liveShard(projectId, 2) !== liveShard(other, 2))
			other = randomUUID();
		let gateway: Awaited<ReturnType<typeof createLiveGateway>> | undefined;
		let server: ReturnType<typeof Bun.serve> | undefined;
		const clients: AbortController[] = [];
		let created = false;
		const publish = async (project = projectId) => {
			const now = (BigInt(Date.now()) * 1000000n).toString(),
				id = randomUUID();
			const raw = rawType
				.encode(
					rawType.fromObject({
						security: { project_id: project, source_id: "test" },
						record_id: id,
						received_unix_nano: now,
						otlp_request: otlpType
							.encode(
								otlpType.fromObject({
									resource_metrics: [
										{
											scope_metrics: [
												{
													metrics: [
														{
															name: "metric",
															gauge: {
																data_points: [
																	{
																		time_unix_nano: now,
																		as_int: "9223372036854775807",
																	},
																],
															},
														},
													],
												},
											],
										},
									],
								}),
							)
							.finish(),
					}),
				)
				.finish();
			const location = (
				await producer.send({
					topic: rawTopic,
					messages: [{ value: Buffer.from(raw) }],
				})
			)[0];
			const value = notificationType
				.encode(
					notificationType.fromObject({
						project_id: project,
						source_id: "test",
						record_id: id,
						received_unix_nano: now,
						measured_unix_nano: now,
						resources: 1,
						metrics: 1,
						points: 1,
						bytes: raw.length,
						raw_partition: location.partition,
						raw_offset: location.baseOffset,
					}),
				)
				.finish();
			await producer.send({
				topic,
				messages: [
					{
						partition: liveShard(project, 2),
						key: project,
						value: Buffer.from(value),
					},
				],
			});
			return {
				id,
				partition: location.partition,
				offset: location.baseOffset ?? "0",
			};
		};
		const connect = async () => {
			const abort = new AbortController();
			clients.push(abort);
			const response = await fetch(
				`${server?.url}stream?projectId=${projectId}`,
				{ headers, signal: abort.signal },
			);
			expect(response.headers.get("content-type")).toContain(
				"text/event-stream",
			);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing SSE body");
			let pending = "";
			const decoder = new TextDecoder();
			const next = async (kind: string): Promise<Record<string, unknown>> => {
				const timeout = setTimeout(() => abort.abort(), 15000);
				try {
					for (;;) {
						const index = pending.indexOf("\n\n");
						if (index >= 0) {
							const frame = pending.slice(0, index);
							pending = pending.slice(index + 2);
							expect(frame).not.toContain("id:");
							if (frame.startsWith(`event: ${kind}\n`))
								return JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
							continue;
						}
						const chunk = await reader.read();
						if (chunk.done) throw new Error("Unexpected SSE end");
						pending += decoder.decode(chunk.value, { stream: true });
					}
				} finally {
					clearTimeout(timeout);
				}
			};
			await next("connected");
			return { next, abort };
		};
		try {
			await admin.connect();
			created = await admin.createTopics({
				topics: [
					{
						topic,
						numPartitions: 2,
						replicationFactor: 1,
						configEntries: [{ name: "max.message.bytes", value: "65536" }],
					},
					{
						topic: rawTopic,
						numPartitions: 2,
						replicationFactor: 1,
						configEntries: [{ name: "max.message.bytes", value: "6291456" }],
					},
				],
				waitForLeaders: true,
			});
			if (!created) throw new Error("Test topics were not fresh");
			await producer.connect();
			const old = await publish();
			gateway = await createLiveGateway();
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: gateway.fetch,
				idleTimeout: 60,
			});
			expect((await fetch(`${server.url}health`)).status).toBe(401);
			const existing = new Set(
				(await admin.listGroups()).groups.map((g) => g.groupId),
			);
			const first = await connect();
			await first.next("heartbeat");
			await publish(other);
			const current = await publish();
			const firstEvent = await first.next("packet");
			expect(firstEvent.projectId).toBe(projectId);
			expect(firstEvent.summary).toMatchObject({ id: current.id });
			expect(firstEvent.summary).not.toMatchObject({ id: old.id });
			expect(firstEvent).not.toHaveProperty("payload");
			const second = await connect();
			const groups = (await admin.listGroups()).groups.filter(
				(g) =>
					!existing.has(g.groupId) &&
					g.groupId.startsWith(
						`recount-live-${createHash("sha256").update(topic).digest("hex").slice(0, 12)}-`,
					),
			);
			expect(groups).toHaveLength(1);
			const assignment = (
				await admin.describeGroups(groups.map((g) => g.groupId))
			).groups[0];
			expect(assignment.members).toHaveLength(1);
			const fresh = await publish();
			expect((await second.next("packet")).summary).toMatchObject({
				id: fresh.id,
			});
			expect((await first.next("packet")).summary).toMatchObject({
				id: fresh.id,
			});
			first.abort.abort();
			second.abort.abort();
			await gateway.close();
			await server.stop(true);
			gateway = await createLiveGateway();
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: gateway.fetch,
				idleTimeout: 60,
			});
			const params = new URLSearchParams({
				projectId,
				packetId: current.id,
				partition: String(current.partition),
				offset: current.offset,
			});
			const detail = await fetch(`${server.url}packet?${params}`, { headers });
			expect(detail.ok).toBe(true);
			expect(JSON.stringify(await detail.json())).toContain(
				"9223372036854775807",
			);
			params.set("projectId", other);
			expect(
				(await fetch(`${server.url}packet?${params}`, { headers })).status,
			).toBe(404);
			const reconnected = await connect();
			const newest = await publish();
			expect((await reconnected.next("packet")).summary).toMatchObject({
				id: newest.id,
			});
		} finally {
			for (const client of clients) client.abort();
			await gateway?.close();
			await server?.stop(true);
			await producer.disconnect();
			if (created) await admin.deleteTopics({ topics: [topic, rawTopic] });
			await admin.disconnect();
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	},
	60000,
);
