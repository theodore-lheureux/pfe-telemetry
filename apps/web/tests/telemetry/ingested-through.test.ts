import { expect, test } from "bun:test";
import { Kafka, logLevel } from "kafkajs";
import { pipelineIngestedThrough } from "../../src/analytics/ingested-through.server";

const broker = process.env.RECOUNT_WATERMARK_TEST_BROKER;

test.skipIf(!broker)(
	"reads the first unread receive time in isolated Kafka lanes",
	async () => {
		if (!broker?.startsWith("127.0.0.1:"))
			throw new Error("Local Kafka required");
		const kafka = new Kafka({ brokers: [broker], logLevel: logLevel.NOTHING });
		const admin = kafka.admin();
		const producer = kafka.producer();
		const prefix = `recount.local.watermark.${crypto.randomUUID()}`;
		const topics = ["raw", "recent", "late"].map((name) => `${prefix}.${name}`);
		const groups = topics.map((topic) => `${topic}.storage`);
		const settings = {
			RECOUNT_ACTIVITY_KAFKA_BROKERS: broker,
			RECOUNT_RAW_TOPIC: topics[0],
			RECOUNT_NORMALIZED_TOPIC: topics[1],
			RECOUNT_LATE_TOPIC: topics[2],
			RECOUNT_NORMALIZER_GROUP: groups[0],
			RECOUNT_CLICKHOUSE_GROUP: groups[1],
			RECOUNT_CLICKHOUSE_LATE_GROUP: groups[2],
		};
		const env = { ...process.env };
		Object.assign(process.env, settings);
		await admin.connect();
		try {
			await admin.createTopics({
				topics: topics.map((topic) => ({
					topic,
					numPartitions: 2,
					replicationFactor: 1,
				})),
			});
			await producer.connect();
			const now = Date.now();
			await Promise.all(
				topics.map((topic, i) =>
					producer.send({
						topic,
						messages: [
							...(i === 2
								? [
										{
											partition: 0,
											value: "already stored",
											timestamp: String(now - 30_000),
											headers: {
												"recount-raw-received-ms": String(now - 30_000),
											},
										},
									]
								: []),
							{
								partition: 0,
								value: "first unread",
								timestamp: String(now),
								headers: {
									"recount-raw-received-ms": String(now - i * 10_000),
								},
							},
							{
								partition: 1,
								value: "other partition",
								timestamp: String(now),
								headers: { "recount-raw-received-ms": String(now) },
							},
						],
					}),
				),
			);
			const worker = kafka.consumer({
				groupId: groups[2],
				allowAutoTopicCreation: false,
			});
			await worker.connect();
			try {
				await worker.subscribe({ topic: topics[2] });
				await worker.run({ autoCommit: false, eachMessage: async () => {} });
				await worker.commitOffsets([
					{ topic: topics[2], partition: 0, offset: "1" },
				]);
			} finally {
				await worker.disconnect();
			}
			expect(await pipelineIngestedThrough()).toEqual(new Date(now - 20_000));
		} finally {
			for (const key of Object.keys(settings)) {
				if (env[key] === undefined) delete process.env[key];
				else process.env[key] = env[key];
			}
			await producer.disconnect();
			await admin.deleteTopics({ topics });
			await admin.disconnect();
		}
	},
	15_000,
);
