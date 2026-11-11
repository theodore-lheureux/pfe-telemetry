import { createHash, randomUUID } from "node:crypto";
import type { getDatabase } from "../src/db/client.server";
import { collectorNode, enrollmentKey } from "../src/db/schema";

/** Inserts an enrollment key and one enrolled node, for tests that need a telemetry source. */
export async function createTestNode(
	database: Pick<ReturnType<typeof getDatabase>, "insert">,
	reference: { organizationId: string; projectId: string },
	{
		hostname = "node1",
		machineId = "node1",
		nodeId = randomUUID(),
	}: { hostname?: string; machineId?: string; nodeId?: string } = {},
) {
	const enrollmentKeyId = randomUUID();
	await database.insert(enrollmentKey).values({
		id: enrollmentKeyId,
		...reference,
		name: "Test key",
		keySha256: createHash("sha256").update(randomUUID()).digest("hex"),
	});
	await database.insert(collectorNode).values({
		id: nodeId,
		...reference,
		enrollmentKeyId,
		machineId,
		hostname,
		publicKey: "A".repeat(43),
	});
	return { nodeId, enrollmentKeyId };
}
