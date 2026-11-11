import { createHash, randomUUID } from "node:crypto";
import { AssignerProtocol, type Consumer, Kafka, logLevel } from "kafkajs";
import { OperationError } from "../lib/operation-error";
import { decodePacket } from "./codec.server";
import type { PacketInput } from "./contracts";
import { ownLiveConnection } from "./live-connection.server";

export function liveKafkaSettings() {
	const brokers = process.env.RECOUNT_ACTIVITY_KAFKA_BROKERS?.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	const topic = process.env.RECOUNT_LIVE_TOPIC ?? "recount.metrics.live";
	const rawTopic = process.env.RECOUNT_RAW_TOPIC ?? "recount.metrics.raw";
	const partitions = Number(process.env.RECOUNT_LIVE_PARTITIONS ?? "8");
	if (
		!brokers?.length ||
		brokers.some(
			(b) => !/^(?:[a-zA-Z0-9_.-]+|\[[0-9a-fA-F:]+\]):[0-9]+$/.test(b),
		) ||
		![topic, rawTopic].every((t) => /^[a-zA-Z0-9_.-]{1,200}$/.test(t)) ||
		topic === rawTopic ||
		!Number.isInteger(partitions) ||
		partitions < 1 ||
		partitions > 256
	)
		throw new Error("Invalid Live Kafka configuration");
	return { brokers, topic, rawTopic, partitions };
}

// Each ephemeral reader owns precisely one partition, without joining pipeline groups.
export function partitionConsumer(
	kafka: Kafka,
	topic: string,
	partition: number,
	raw = false,
) {
	return kafka.consumer({
		groupId: `recount-live-${createHash("sha256").update(topic).digest("hex").slice(0, 12)}-${randomUUID()}`,
		allowAutoTopicCreation: false,
		retry: { retries: 2, restartOnFailure: async () => false },
		sessionTimeout: 10000,
		rebalanceTimeout: 5000,
		maxWaitTimeInMs: 100,
		maxBytesPerPartition: raw ? 6291456 : 65536,
		maxBytes: raw ? 8388608 : 131072,
		partitionAssigners: [
			() => ({
				name: "recount-live-partition",
				version: 0,
				protocol: ({ topics }) => ({
					name: "recount-live-partition",
					metadata: AssignerProtocol.MemberMetadata.encode({
						version: 0,
						topics,
						userData: Buffer.alloc(0),
					}),
				}),
				assign: async ({ members }) =>
					members.map((member) => ({
						memberId: member.memberId,
						memberAssignment: AssignerProtocol.MemberAssignment.encode({
							version: 0,
							assignment: { [topic]: [partition] },
							userData: Buffer.alloc(0),
						}),
					})),
			}),
		],
	});
}

export function createLiveKafka() {
	return new Kafka({
		clientId: "recount-live",
		brokers: liveKafkaSettings().brokers,
		logLevel: logLevel.NOTHING,
		connectionTimeout: 3000,
		requestTimeout: 5000,
		retry: { retries: 2 },
	});
}

export async function stopConsumer(consumer: Consumer) {
	try {
		await consumer.stop();
	} finally {
		await consumer.disconnect();
	}
}

export function readRawPacket(
	kafka: Kafka,
	input: PacketInput,
	signal: AbortSignal,
	topic = liveKafkaSettings().rawTopic,
) {
	const consumer = partitionConsumer(kafka, topic, input.partition, true);
	const timeoutController = new AbortController();
	const deadline = AbortSignal.any([signal, timeoutController.signal]);
	const timeout = setTimeout(() => timeoutController.abort(), 10000);
	let complete: (bytes: Buffer) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const found = new Promise<Buffer>((resolve, fail) => {
		complete = resolve;
		reject = fail;
	});
	// Startup can fail before the result is awaited.
	void found.catch(() => {});
	const missing = () =>
		reject(new OperationError("NOT_FOUND", "Packet unavailable"));
	deadline.addEventListener("abort", missing, { once: true });
	consumer.on(consumer.events.CRASH, missing);
	consumer.on(consumer.events.GROUP_JOIN, () => {
		if (deadline.aborted) return;
		consumer.seek({ topic, partition: input.partition, offset: input.offset });
	});
	const connection = ownLiveConnection(
		deadline,
		async (stopped) => {
			await consumer.connect();
			if (stopped()) return;
			await consumer.subscribe({ topic, fromBeginning: false });
			if (stopped()) return;
			await consumer.run({
				autoCommit: false,
				eachMessage: async ({ message }) => {
					if (stopped()) return;
					if (message.offset === input.offset && message.value)
						complete(message.value);
					else if (BigInt(message.offset) > BigInt(input.offset)) missing();
				},
			});
		},
		() => stopConsumer(consumer),
	);
	const result = (async () => {
		try {
			await connection.ready;
			const bytes = await found;
			const decoded = decodePacket(
				bytes,
				input.partition,
				input.offset,
				input.projectId,
			);
			if (decoded.detail.summary.id !== input.packetId)
				throw new OperationError("NOT_FOUND", "Packet unavailable");
			return decoded.detail;
		} finally {
			clearTimeout(timeout);
			deadline.removeEventListener("abort", missing);
		}
	})();
	const closed = result.then(
		() => connection.close(),
		() => connection.close(),
	);
	void closed.catch(() => {});
	return { result, closed };
}
