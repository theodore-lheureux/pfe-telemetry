import type { Admin, Kafka, KafkaMessage } from "kafkajs";
import * as z from "zod";
import { ownLiveConnection } from "../activity/live-connection.server";
import {
	createLiveKafka,
	liveKafkaSettings,
	partitionConsumer,
	stopConsumer,
	topicName,
} from "../activity/live-kafka.server";
import { readEnv } from "../lib/env.server";

type Lane = { topic: string; groupId: string; raw: boolean };
type Position = { partition: number; offset: string };
type Offsets = Pick<Admin, "fetchOffsets" | "fetchTopicOffsets">;

const settings = z.object({
	RECOUNT_NORMALIZER_GROUP: z
		.string()
		.trim()
		.min(1)
		.default("recount-normalizer"),
	RECOUNT_NORMALIZED_TOPIC: topicName("RECOUNT_NORMALIZED_TOPIC").default(
		"recount.metrics.normalized-packed",
	),
	RECOUNT_LATE_TOPIC: topicName("RECOUNT_LATE_TOPIC").default(
		"recount.metrics.late",
	),
	RECOUNT_CLICKHOUSE_GROUP: z
		.string()
		.trim()
		.min(1)
		.default("recount-clickhouse"),
	RECOUNT_CLICKHOUSE_LATE_GROUP: z
		.string()
		.trim()
		.min(1)
		.default("recount-clickhouse-late"),
});

async function pendingOffsets(admin: Offsets, { topic, groupId }: Lane) {
	// Read commits before ends so concurrent writes can't hide lag.
	const [committed] = await admin.fetchOffsets({ groupId, topics: [topic] });
	const ends = await admin.fetchTopicOffsets(topic);
	const byPartition = new Map(
		committed?.partitions.map(({ partition, offset }) => [
			partition,
			BigInt(offset),
		]),
	);
	if (!ends.length || ends.length !== byPartition.size)
		throw new Error("Incomplete Kafka offset snapshot");
	return ends.flatMap(({ partition, low, high }) => {
		const commit = byPartition.get(partition);
		if (commit === undefined) throw new Error("Missing Kafka partition offset");
		const start = BigInt(low);
		const offset = commit < start ? start : commit;
		return offset < BigInt(high)
			? [{ partition, offset: offset.toString() }]
			: [];
	});
}

export async function calculateIngestedThrough(
	admin: Offsets,
	lanes: Lane[],
	read: (lane: Lane, positions: Position[]) => Promise<number[]>,
	now = Date.now(),
) {
	// Snapshot upstream first: a raw commit can hand work off to either storage lane.
	const snapshots: Position[][] = [];
	for (const lane of lanes) snapshots.push(await pendingOffsets(admin, lane));
	const timestamps = await Promise.all(
		lanes.map(async (lane, index) => {
			const positions = snapshots[index];
			if (!positions.length) return [];
			const stamps = await read(lane, positions);
			if (
				stamps.length !== positions.length ||
				!stamps.every((stamp) => Number.isSafeInteger(stamp) && stamp >= 0)
			)
				throw new Error("Incomplete Kafka timestamp snapshot");
			return stamps;
		}),
	);
	return new Date(Math.min(now, ...timestamps.flat()));
}

function receiveTime(message: KafkaMessage, raw: boolean) {
	const value = raw
		? message.timestamp
		: message.headers?.["recount-raw-received-ms"];
	const stamp = Array.isArray(value) ? undefined : value?.toString();
	return stamp && /^\d+$/.test(stamp) ? Number(stamp) : NaN;
}

async function readTimestamps(
	kafka: Kafka,
	lane: Lane,
	positions: Position[],
	signal: AbortSignal,
) {
	const { topic, raw } = lane;
	const consumer = partitionConsumer(
		kafka,
		topic,
		positions.map(({ partition }) => partition),
		true,
	);
	const pending = new Map(
		positions.map(({ partition, offset }) => [partition, offset]),
	);
	const stamps: number[] = [];
	const { promise, resolve } = Promise.withResolvers<number[]>();
	consumer.on(consumer.events.CRASH, () => resolve([]));
	consumer.on(consumer.events.GROUP_JOIN, () => {
		if (signal.aborted) return;
		for (const position of positions) consumer.seek({ topic, ...position });
	});
	const connection = ownLiveConnection(
		signal,
		async (stopped) => {
			await consumer.connect();
			if (stopped()) return;
			await consumer.subscribe({ topic, fromBeginning: false });
			if (stopped()) return;
			await consumer.run({
				autoCommit: false,
				eachMessage: async ({ partition, message, pause }) => {
					const offset = pending.get(partition);
					if (!offset || BigInt(message.offset) < BigInt(offset)) return;
					if (message.offset !== offset) {
						resolve([]);
						return;
					}
					stamps.push(receiveTime(message, raw));
					pending.delete(partition);
					pause();
					if (!pending.size) resolve(stamps);
				},
			});
		},
		() => stopConsumer(consumer),
	);
	const aborted = () => resolve([]);
	signal.addEventListener("abort", aborted, { once: true });
	try {
		await connection.ready;
		return await promise;
	} finally {
		signal.removeEventListener("abort", aborted);
		void connection.close().catch(() => {});
	}
}

async function readWatermark(signal: AbortSignal) {
	const config = readEnv(settings, process.env);
	const kafka = createLiveKafka();
	const admin = kafka.admin({ retry: { retries: 0 } });
	try {
		await admin.connect();
		signal.throwIfAborted();
		return await calculateIngestedThrough(
			admin,
			[
				{
					topic: liveKafkaSettings().rawTopic,
					groupId: config.RECOUNT_NORMALIZER_GROUP,
					raw: true,
				},
				{
					topic: config.RECOUNT_NORMALIZED_TOPIC,
					groupId: config.RECOUNT_CLICKHOUSE_GROUP,
					raw: false,
				},
				{
					topic: config.RECOUNT_LATE_TOPIC,
					groupId: config.RECOUNT_CLICKHOUSE_LATE_GROUP,
					raw: false,
				},
			],
			(lane, positions) => readTimestamps(kafka, lane, positions, signal),
		);
	} finally {
		await admin.disconnect();
	}
}

const CACHE_MS = 5_000;
let cached: { expires: number; value: Promise<Date | null> } | undefined;

export function pipelineIngestedThrough() {
	const now = Date.now();
	if (cached && now < cached.expires) return cached.value;
	const deadline = new AbortController();
	const { promise, resolve } = Promise.withResolvers<null>();
	const timeout = setTimeout(() => {
		deadline.abort();
		resolve(null);
	}, 2_000);
	const value = Promise.race([
		readWatermark(deadline.signal).catch(() => null),
		promise,
	]).finally(() => clearTimeout(timeout));
	cached = { expires: now + CACHE_MS, value };
	return value;
}
