import { createHash, randomUUID } from "node:crypto";
import { AssignerProtocol, type Consumer, Kafka, logLevel } from "kafkajs";
import * as z from "zod";
import { integer, readEnv } from "../lib/env.server";
import { OperationError } from "../lib/operation-error";
import { decodePacket } from "./codec.server";
import type { PacketInput } from "./contracts";
import { ownLiveConnection } from "./live-connection.server";

const brokersError =
	"RECOUNT_ACTIVITY_KAFKA_BROKERS must list host:port brokers, separated by commas";

function topicName(name: string) {
	return z
		.string()
		.regex(/^[a-zA-Z0-9_.-]{1,200}$/, `${name} must be a Kafka topic name`);
}

const settings = z.object({
	RECOUNT_ACTIVITY_KAFKA_BROKERS: z
		.string({ error: brokersError })
		.transform((value) =>
			value
				.split(",")
				.map((broker) => broker.trim())
				.filter(Boolean),
		)
		.pipe(
			z
				.array(
					z
						.string()
						.regex(
							/^(?:[a-zA-Z0-9_.-]+|\[[0-9a-fA-F:]+\]):[0-9]+$/,
							brokersError,
						),
				)
				.min(1, brokersError),
		),
	RECOUNT_LIVE_TOPIC: topicName("RECOUNT_LIVE_TOPIC").default(
		"recount.metrics.live",
	),
	RECOUNT_RAW_TOPIC: topicName("RECOUNT_RAW_TOPIC").default(
		"recount.metrics.raw",
	),
	RECOUNT_LIVE_PARTITIONS: integer("RECOUNT_LIVE_PARTITIONS", 1, 256).default(
		8,
	),
});

export function liveKafkaSettings() {
	const parsed = readEnv(settings, process.env);
	if (parsed.RECOUNT_LIVE_TOPIC === parsed.RECOUNT_RAW_TOPIC)
		throw new Error("RECOUNT_LIVE_TOPIC and RECOUNT_RAW_TOPIC must differ");
	return {
		brokers: parsed.RECOUNT_ACTIVITY_KAFKA_BROKERS,
		topic: parsed.RECOUNT_LIVE_TOPIC,
		rawTopic: parsed.RECOUNT_RAW_TOPIC,
		partitions: parsed.RECOUNT_LIVE_PARTITIONS,
	};
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
