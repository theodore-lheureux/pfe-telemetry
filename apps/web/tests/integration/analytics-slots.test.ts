import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
	readSlotLimits,
	type SlotLimits,
	withAnalyticsSlot,
} from "../../src/analytics/capacity.server";
import { createDatabase } from "../../src/db/client.server";
import { analyticsSlot } from "../../src/db/schema";
import { createTestDatabase } from "../database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
// A second pool on the same database stands in for another web instance.
let other: ReturnType<typeof createDatabase>;
const limits: SlotLimits = { total: 2, organization: 1, waitMs: 400 };

beforeAll(async () => {
	database = await createTestDatabase("slots");
	other = createDatabase({ connectionString: database.url, max: 2 });
});
afterAll(async () => {
	await other?.pool.end();
	await database?.close();
});

/** Holds a slot until `release` is called. */
function hold(
	db: typeof database.db,
	organizationId: string,
	options: SlotLimits = limits,
) {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		void withAnalyticsSlot(
			db,
			organizationId,
			undefined,
			async () => {
				resolve();
				await held;
			},
			options,
		);
	});
	return { started, release };
}

async function heldSlots() {
	return (await database.db.select().from(analyticsSlot)).length;
}

/** Releases finish after the read resolves, so wait for the table to empty. */
async function released() {
	for (let attempt = 0; attempt < 50 && (await heldSlots()) > 0; attempt++)
		await Bun.sleep(20);
	expect(await heldSlots()).toBe(0);
}

test("slots limit each organization and the total across instances", async () => {
	const a = hold(database.db, "org-a");
	await a.started;
	// The same organization waits, then is refused, even from another instance.
	await expect(
		withAnalyticsSlot(other.db, "org-a", undefined, async () => 1, limits),
	).rejects.toMatchObject({ code: "CAPACITY" });
	const b = hold(other.db, "org-b");
	await b.started;
	// Both slots are taken, so a third organization is refused too.
	await expect(
		withAnalyticsSlot(database.db, "org-c", undefined, async () => 1, limits),
	).rejects.toMatchObject({ code: "CAPACITY" });
	a.release();
	b.release();
	await released();
});

test("a waiting read starts when a slot frees, and failed reads free theirs", async () => {
	const a = hold(database.db, "org-a");
	await a.started;
	const waiting = withAnalyticsSlot(
		other.db,
		"org-a",
		undefined,
		async () => "ran",
		{ ...limits, waitMs: 3_000 },
	);
	setTimeout(a.release, 200);
	expect(await waiting).toBe("ran");
	await expect(
		withAnalyticsSlot(database.db, "org-a", undefined, async () => {
			throw new Error("read failed");
		}),
	).rejects.toThrow("read failed");
	expect(await heldSlots()).toBe(0);
});

test("expired reservations from a lost instance are reclaimed", async () => {
	await database.db.insert(analyticsSlot).values({
		organizationId: "org-a",
		expiresAt: sql`statement_timestamp() - interval '1 second'`,
	});
	expect(
		await withAnalyticsSlot(
			database.db,
			"org-a",
			undefined,
			async () => 1,
			limits,
		),
	).toBe(1);
	expect(await heldSlots()).toBe(0);
});

test("a cancelled request stops waiting for a slot", async () => {
	const a = hold(database.db, "org-a");
	await a.started;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	await expect(
		withAnalyticsSlot(database.db, "org-a", controller.signal, async () => 1, {
			...limits,
			waitMs: 3_000,
		}),
	).rejects.toMatchObject({ code: "CANCELLED" });
	a.release();
	await released();
});

test("slot limits are validated", () => {
	expect(readSlotLimits({})).toMatchObject({ total: 2, organization: 1 });
	expect(
		readSlotLimits({
			RECOUNT_ANALYTICS_CONCURRENCY: "8",
			RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY: "4",
		}),
	).toMatchObject({ total: 8, organization: 4 });
	expect(() =>
		readSlotLimits({ RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY: "3" }),
	).toThrow();
	expect(() =>
		readSlotLimits({ RECOUNT_ANALYTICS_CONCURRENCY: "0" }),
	).toThrow();
});
