import { expect, test } from "bun:test";
import { calculateIngestedThrough } from "../../src/analytics/ingested-through.server";

const lanes = [
	{ topic: "raw", groupId: "normalizer", raw: true },
	{ topic: "recent", groupId: "storage", raw: false },
	{ topic: "late", groupId: "late-storage", raw: false },
];

function offsets(rows: Record<string, [string, string, string][]>) {
	return {
		async fetchOffsets({ groupId }: { groupId: string }) {
			return [
				{
					topic: groupId,
					partitions: rows[groupId].map(([offset], partition) => ({
						partition,
						offset,
						metadata: null,
					})),
				},
			];
		},
		async fetchTopicOffsets(topic: string) {
			const group = lanes.find((lane) => lane.topic === topic)?.groupId ?? "";
			return rows[group].map(([, low, high], partition) => ({
				partition,
				low,
				high,
				offset: high,
			}));
		},
	};
}

test("the oldest unread receive time across all lanes sets the watermark", async () => {
	const admin = offsets({
		normalizer: [
			["8", "5", "12"],
			["9007199254740992", "0", "9007199254740993"],
		],
		storage: [
			["-1", "7", "8"],
			["0", "0", "0"],
		],
		"late-storage": [["1", "4", "10"]],
	});
	const watermark = await calculateIngestedThrough(
		admin,
		lanes,
		async ({ topic }, positions) => {
			if (topic === "raw") {
				expect(positions).toEqual([
					{ partition: 0, offset: "8" },
					{ partition: 1, offset: "9007199254740992" },
				]);
				return [30, 25];
			}
			if (topic === "recent") {
				expect(positions).toEqual([{ partition: 0, offset: "7" }]);
				return [20];
			}
			expect(positions).toEqual([{ partition: 0, offset: "4" }]);
			return [10];
		},
		100,
	);
	expect(watermark).toEqual(new Date(10));
});

test("caught-up lanes need no reads; an unreadable lagged offset cannot imply catch-up", async () => {
	const read = async () => [];
	const rows: Record<string, [string, string, string][]> = {
		normalizer: [["8", "5", "8"]],
		storage: [["-1", "0", "0"]],
		"late-storage": [["1", "0", "1"]],
	};
	expect(
		await calculateIngestedThrough(offsets(rows), lanes, read, 100),
	).toEqual(new Date(100));
	rows.storage = [["-1", "0", "1"]];
	await expect(
		calculateIngestedThrough(offsets(rows), lanes, read, 100),
	).rejects.toThrow("Incomplete Kafka timestamp snapshot");
});
