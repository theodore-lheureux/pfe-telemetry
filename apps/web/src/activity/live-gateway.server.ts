import { timingSafeEqual } from "node:crypto";
import { decodeNotification, liveShard } from "./codec.server";
import { ownLiveConnection } from "./live-connection.server";
import { LiveHub } from "./live-hub.server";
import {
	createLiveKafka,
	liveKafkaSettings,
	partitionConsumer,
	readRawPacket,
	stopConsumer,
} from "./live-kafka.server";
import { sseChannel, sseHeaders } from "./sse.server";
import { parsePacket } from "./validation";

export function gatewaySecret() {
	const secret = process.env.RECOUNT_LIVE_GATEWAY_SECRET;
	if (!secret || secret.length < 32)
		throw new Error(
			"RECOUNT_LIVE_GATEWAY_SECRET must contain at least 32 characters",
		);
	return secret;
}

export async function createLiveGateway() {
	const secret = Buffer.from(`Bearer ${gatewaySecret()}`);
	const settings = liveKafkaSettings();
	const kafka = createLiveKafka(),
		admin = kafka.admin();
	await admin.connect();
	try {
		const metadata = await admin.fetchTopicMetadata({
			topics: [settings.topic],
		});
		if (metadata.topics[0]?.partitions.length !== settings.partitions)
			throw new Error("Live partition count mismatch");
	} catch (error) {
		await admin.disconnect();
		throw error;
	}
	const hub = new LiveHub({
		async end(partition) {
			const offsets = await admin.fetchTopicOffsets(settings.topic);
			const offset = offsets.find((o) => o.partition === partition)?.high;
			if (offset === undefined) throw new Error("Live shard unavailable");
			return offset;
		},
		start(partition, from, signal, receive, failed) {
			const consumer = partitionConsumer(kafka, settings.topic, partition);
			const timeoutController = new AbortController();
			const timer = setTimeout(() => timeoutController.abort(), 10000);
			const deadline = AbortSignal.any([signal, timeoutController.signal]);
			let nextOffset = from;
			let joined: () => void = () => {},
				rejected: (error: Error) => void = () => {};
			const assignment = new Promise<void>((resolve, reject) => {
				joined = resolve;
				rejected = reject;
			});
			void assignment.catch(() => {});
			const cancelAssignment = () =>
				rejected(new Error("Live startup cancelled"));
			deadline.addEventListener("abort", cancelAssignment, { once: true });
			consumer.on(consumer.events.GROUP_JOIN, () => {
				if (deadline.aborted) return;
				consumer.seek({ topic: settings.topic, partition, offset: nextOffset });
				joined();
			});
			consumer.on(consumer.events.CRASH, () => {
				rejected(new Error("Live consumer failed"));
				failed();
			});
			const connection = ownLiveConnection(
				deadline,
				async (stopped) => {
					await consumer.connect();
					if (stopped()) return;
					await consumer.subscribe({
						topic: settings.topic,
						fromBeginning: false,
					});
					if (stopped()) return;
					await consumer.run({
						autoCommit: false,
						eachMessage: async ({ message }) => {
							if (
								stopped() ||
								!message.value ||
								BigInt(message.offset) < BigInt(nextOffset)
							)
								return;
							nextOffset = (BigInt(message.offset) + 1n).toString();
							try {
								const event = decodeNotification(message.value);
								if (
									liveShard(event.projectId, settings.partitions) !== partition
								)
									throw new Error("Wrong notification shard");
								receive(message.offset, event);
							} catch {
								failed();
							}
						},
					});
					await assignment;
				},
				() => stopConsumer(consumer),
			);
			void connection.ready.then(
				() => {
					clearTimeout(timer);
					deadline.removeEventListener("abort", cancelAssignment);
				},
				() => {
					clearTimeout(timer);
					deadline.removeEventListener("abort", cancelAssignment);
					rejected(new Error("Live startup failed"));
					failed();
				},
			);
			return connection;
		},
	});
	let readers = 0,
		viewers = 0;
	const connections = new Set<AbortController>();
	const packetReads = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	return {
		async fetch(request: Request): Promise<Response> {
			if (closing) return new Response(null, { status: 503 });
			const authorization = Buffer.from(
				request.headers.get("authorization") ?? "",
			);
			if (
				authorization.length !== secret.length ||
				!timingSafeEqual(authorization, secret)
			)
				return new Response(null, { status: 401 });
			const url = new URL(request.url);
			if (request.method !== "GET") return new Response(null, { status: 405 });
			if (url.pathname === "/health") return Response.json({ ready: true });
			const projectId = url.searchParams.get("projectId") ?? "";
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					projectId,
				)
			)
				return new Response(null, { status: 400 });
			if (url.pathname === "/packet") {
				if (readers >= 2) return new Response(null, { status: 503 });
				readers++;
				const lifetime = new AbortController();
				connections.add(lifetime);
				let started = false;
				try {
					const input = parsePacket({
						organizationId: "internal",
						projectId,
						packetId: url.searchParams.get("packetId"),
						offset: url.searchParams.get("offset"),
						partition: Number(url.searchParams.get("partition")),
					});
					const read = readRawPacket(
						kafka,
						input,
						AbortSignal.any([request.signal, lifetime.signal]),
					);
					started = true;
					packetReads.add(read.closed);
					void read.closed
						.finally(() => {
							packetReads.delete(read.closed);
							readers--;
							connections.delete(lifetime);
						})
						.catch(() => {});
					return Response.json(await read.result, {
						headers: { "Cache-Control": "no-store" },
					});
				} catch {
					return new Response(null, { status: 404 });
				} finally {
					if (!started) {
						readers--;
						connections.delete(lifetime);
					}
				}
			}
			if (url.pathname !== "/stream")
				return new Response(null, { status: 404 });
			if (viewers >= 512) return new Response(null, { status: 503 });
			viewers++;
			const lifetime = new AbortController();
			connections.add(lifetime);
			const signal = AbortSignal.any([request.signal, lifetime.signal]);
			let unsubscribe = () => {};
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const channel = sseChannel(signal, () => {
				viewers--;
				clearInterval(heartbeat);
				lifetime.abort();
				unsubscribe();
				connections.delete(lifetime);
			});
			try {
				unsubscribe = await hub.subscribe(
					liveShard(projectId, settings.partitions),
					projectId,
					signal,
					(event) => channel.send("packet", event),
					() => channel.close(),
				);
				if (channel.closed) unsubscribe();
				else {
					channel.send("connected", {});
					heartbeat = setInterval(() => channel.send("heartbeat", {}), 10000);
				}
			} catch {
				channel.send("unavailable", {});
				channel.close();
			}
			return new Response(channel.body, { headers: sseHeaders });
		},
		close() {
			closing ??= (async () => {
				for (const connection of connections) connection.abort();
				await hub.close();
				await Promise.allSettled(packetReads);
				await admin.disconnect();
			})();
			return closing;
		},
	};
}
