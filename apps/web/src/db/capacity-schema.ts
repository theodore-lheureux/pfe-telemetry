import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "./auth-schema";

// Running ClickHouse reads, shared by every web instance. The migration creates the
// table UNLOGGED: rows live seconds, so they skip the write-ahead log and replication,
// and a crash only forgets reservations that expire anyway.
export const analyticsSlot = appSchema.table(
	"analytics_slot",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		organizationId: text("organization_id").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("analytics_slot_organization_idx").on(table.organizationId),
	],
);
