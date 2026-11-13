import { count, eq, lt, sql } from "drizzle-orm";
import * as z from "zod";
import type { getDatabase } from "../db/client.server";
import { analyticsSlot } from "../db/schema";
import { type Env, integer, readEnv } from "../lib/env.server";
import { OperationError } from "../lib/operation-error";

type Database = ReturnType<typeof getDatabase>;

export interface SlotLimits {
	/** Reads running at once across every instance; at most the reader user's ClickHouse cap. */
	total: number;
	/** Reads one organization may run at once, so none takes every slot. */
	organization: number;
	/** How long a read waits for a slot before it is refused. */
	waitMs: number;
}

/** A reservation outlives any read's deadline, so only a crashed instance's expire. */
const LEASE_SECONDS = 60;

const settings = z.object({
	RECOUNT_ANALYTICS_CONCURRENCY: integer(
		"RECOUNT_ANALYTICS_CONCURRENCY",
		1,
		1000,
	).default(2),
	RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY: integer(
		"RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY",
		1,
		1000,
	).default(1),
});

export function readSlotLimits(env: Env = process.env): SlotLimits {
	const {
		RECOUNT_ANALYTICS_CONCURRENCY: total,
		RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY: organization,
	} = readEnv(settings, env);
	if (organization > total)
		throw new Error(
			"RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY must not exceed RECOUNT_ANALYTICS_CONCURRENCY",
		);
	return { total, organization, waitMs: 5_000 };
}

let configured: SlotLimits | undefined;

function configuredLimits() {
	configured ??= readSlotLimits();
	return configured;
}

/** Reserves a slot if both limits allow it; null when full. */
function tryAcquire(
	database: Database,
	organizationId: string,
	limits: SlotLimits,
) {
	return database.transaction(async (tx) => {
		// One lock serializes reservations, so concurrent instances cannot both take the
		// last slot. It is held for these few statements only, never during a read.
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext('recount.analytics_slot'))`,
		);
		await tx
			.delete(analyticsSlot)
			.where(lt(analyticsSlot.expiresAt, sql`statement_timestamp()`));
		const [held] = await tx
			.select({
				total: count(),
				organization: count(
					sql`CASE WHEN ${analyticsSlot.organizationId} = ${organizationId} THEN 1 END`,
				),
			})
			.from(analyticsSlot);
		if (held.total >= limits.total || held.organization >= limits.organization)
			return null;
		const [slot] = await tx
			.insert(analyticsSlot)
			.values({
				organizationId,
				expiresAt: sql`statement_timestamp() + make_interval(secs => ${LEASE_SECONDS})`,
			})
			.returning({ id: analyticsSlot.id });
		return slot.id;
	});
}

function pause(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

function cancelled(): never {
	throw new OperationError("CANCELLED", "Analytics request cancelled");
}

/**
 * Runs a ClickHouse read once a slot is free, waiting briefly when every slot is taken.
 * Slots are shared through PostgreSQL, so the limits hold across web instances.
 */
export async function withAnalyticsSlot<T>(
	database: Database,
	organizationId: string,
	signal: AbortSignal | undefined,
	read: () => Promise<T>,
	limits: SlotLimits = configuredLimits(),
): Promise<T> {
	const deadline = Date.now() + limits.waitMs;
	let slot: string | null = null;
	while (!slot) {
		if (signal?.aborted) cancelled();
		slot = await tryAcquire(database, organizationId, limits);
		if (slot) break;
		if (Date.now() >= deadline)
			throw new OperationError("CAPACITY", "Analytics is busy");
		// Random spacing keeps waiting requests from retrying in step.
		await pause(
			Math.min(100 + Math.random() * 150, deadline - Date.now()),
			signal,
		);
	}
	try {
		return await read();
	} finally {
		// A failed release leaves the reservation to expire.
		await database
			.delete(analyticsSlot)
			.where(eq(analyticsSlot.id, slot))
			.catch(() => undefined);
	}
}
