import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Kafka, logLevel } from "kafkajs";

const brokers = process.env.RECOUNT_KAFKA_ACL_TEST_BROKERS;
const directory = process.env.RECOUNT_KAFKA_ACL_TEST_SECRETS;
const run = brokers && directory ? test : test.skip;

function client(username: string, wrong = false, errors?: string[]) {
	return new Kafka({
		brokers: (brokers ?? "").split(","),
		logLevel: errors ? logLevel.DEBUG : logLevel.NOTHING,
		...(errors
			? {
					logCreator:
						() =>
						({ log }) => {
							const error = log.error as { type?: string } | undefined;
							if (error?.type) errors.push(error.type);
						},
				}
			: {}),
		retry: { retries: 0 },
		...(username
			? {
					sasl: {
						mechanism: "scram-sha-512" as const,
						username,
						password: wrong
							? "0".repeat(64)
							: readFileSync(
									join(directory ?? "", `${username}.password`),
									"utf8",
								).trim(),
					},
				}
			: {}),
	});
}

const raw = "recount.metrics.raw";
const normalized = "recount.metrics.normalized-packed";
const runtime = [
	"ingestion-api",
	"normalizer",
	"clickhouse",
	"live",
	"kafka-exporter",
];

run(
	"only the API can write raw on the disposable authenticated broker",
	async () => {
		await Promise.all(
			runtime.map(async (user) => {
				const producer = client(user).producer({
					allowAutoTopicCreation: false,
				});
				await producer.connect();
				try {
					const send = (topic: string) =>
						producer.send({
							topic,
							messages: [{ value: "disposable ACL test" }],
						});
					if (user === "ingestion-api") {
						await expect(send(raw)).resolves.toHaveLength(1);
						await expect(send(normalized)).rejects.toThrow(/authorization/i);
					} else {
						await expect(send(raw)).rejects.toThrow(/authorization/i);
						if (user === "normalizer")
							await expect(send(normalized)).resolves.toHaveLength(1);
					}
				} finally {
					await producer.disconnect();
				}
			}),
		);
	},
	30_000,
);

run(
	"wrong credentials, unrelated groups and administration are denied",
	async () => {
		const wrong = client("ingestion-api", true).admin();
		try {
			await expect(wrong.connect()).rejects.toThrow(/authentication/i);
		} finally {
			await wrong.disconnect();
		}
		const unauthenticated = client("").admin();
		try {
			await unauthenticated.connect();
			await expect(unauthenticated.listTopics()).rejects.toThrow();
		} finally {
			await unauthenticated.disconnect();
		}
		const errors: string[] = [];
		const exporter = client("kafka-exporter", false, errors).admin();
		await exporter.connect();
		try {
			await expect(exporter.fetchTopicOffsets(raw)).resolves.not.toHaveLength(
				0,
			);
			await expect(
				exporter.fetchOffsets({ groupId: "recount-unrelated", topics: [raw] }),
			).rejects.toThrow();
			expect(errors).toContain("GROUP_AUTHORIZATION_FAILED");
			const failure = await exporter
				.createTopics({
					topics: [{ topic: "recount-acl-forbidden" }],
				})
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				errors: [
					expect.objectContaining({ type: "TOPIC_AUTHORIZATION_FAILED" }),
				],
			});
		} finally {
			await exporter.disconnect();
		}
	},
	30_000,
);
