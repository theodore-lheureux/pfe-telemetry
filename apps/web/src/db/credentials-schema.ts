import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	pgSchema,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { project } from "./projects-schema";

export const ingestionSchema = pgSchema("ingestion");

export const collectorCredential = ingestionSchema.table(
	"collector_credential",
	{
		id: uuid("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		projectId: uuid("project_id").notNull(),
		sourceId: text("source_id").notNull(),
		name: text("name").notNull(),
		tokenSha256: text("token_sha256").notNull().unique(),
		hosts: text("hosts").array().notNull(),
		requireHostId: boolean("require_host_id").default(true).notNull(),
		maximumSubmissionAge: integer("maximum_submission_age")
			.default(3600)
			.notNull(),
		allowedClockSkew: integer("allowed_clock_skew").default(60).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		rotatedAt: timestamp("rotated_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "collector_credential_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		index("collector_credential_project_idx").on(
			table.projectId,
			table.organizationId,
		),
		check(
			"collector_credential_digest",
			sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"collector_credential_name",
			sql`length(btrim(${table.name})) BETWEEN 1 AND 120`,
		),
		check(
			"collector_credential_source",
			sql`app.collector_identifier_valid(${table.sourceId})`,
		),
		check(
			"collector_credential_hosts",
			sql`app.collector_hosts_valid(${table.hosts}) AND (NOT ${table.requireHostId} OR cardinality(${table.hosts}) > 0)`,
		),
		check(
			"collector_credential_submission_age",
			sql`${table.maximumSubmissionAge} BETWEEN 1 AND 86400`,
		),
		check(
			"collector_credential_clock_skew",
			sql`${table.allowedClockSkew} BETWEEN 1 AND 3600`,
		),
		check(
			"collector_credential_expiration",
			sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
		),
	],
);
