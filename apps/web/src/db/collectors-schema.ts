import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	pgSchema,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { project } from "./projects-schema";

export const ingestionSchema = pgSchema("ingestion");

// An enrollment key lets collectors register themselves as nodes of one project. Its
// policy is copied into every access token issued to those nodes; it never submits
// telemetry itself.
export const enrollmentKey = ingestionSchema.table(
	"enrollment_key",
	{
		id: uuid("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		projectId: uuid("project_id").notNull(),
		name: text("name").notNull(),
		keySha256: text("key_sha256").notNull().unique(),
		adapter: text("adapter").notNull().default("linux"),
		allowedLocalKinds: integer("allowed_local_kinds")
			.array()
			.notNull()
			.default(sql`ARRAY[4,6]::integer[]`),
		maximumSubmissionAge: bigint("maximum_submission_age", { mode: "number" })
			.default(3600)
			.notNull(),
		allowedClockSkew: bigint("allowed_clock_skew", { mode: "number" })
			.default(60)
			.notNull(),
		maxNodes: integer("max_nodes"),
		labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		unique("enrollment_key_tenant_key").on(
			table.id,
			table.projectId,
			table.organizationId,
		),
		foreignKey({
			name: "enrollment_key_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		index("enrollment_key_project_idx").on(
			table.projectId,
			table.organizationId,
		),
		check("enrollment_key_digest", sql`${table.keySha256} ~ '^[0-9a-f]{64}$'`),
		check(
			"enrollment_key_name",
			sql`length(btrim(${table.name})) BETWEEN 1 AND 120`,
		),
		check(
			"enrollment_key_adapter",
			sql`${table.adapter} IN ('standard', 'linux') AND ${table.allowedLocalKinds} <@ ARRAY[2,3,4,6,8]::integer[] AND cardinality(${table.allowedLocalKinds}) <= 5 AND (${table.adapter} <> 'standard' OR cardinality(${table.allowedLocalKinds}) = 0)`,
		),
		check(
			"enrollment_key_submission_age",
			sql`${table.maximumSubmissionAge} BETWEEN 1 AND 18446744073`,
		),
		check(
			"enrollment_key_clock_skew",
			sql`${table.allowedClockSkew} >= 0 AND ${table.maximumSubmissionAge}::numeric + ${table.allowedClockSkew}::numeric <= 18446744073`,
		),
		check(
			"enrollment_key_max_nodes",
			sql`${table.maxNodes} IS NULL OR ${table.maxNodes} BETWEEN 1 AND 1000000`,
		),
		check(
			"enrollment_key_labels",
			sql`cardinality(${table.labels}) <= 20 AND array_position(${table.labels}, NULL) IS NULL`,
		),
		check(
			"enrollment_key_expiration",
			sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
		),
	],
);

// One enrolled machine. The machine ID is the node's root resource; the node ID is its
// telemetry source. The collector holds the private half of `public_key`.
export const collectorNode = ingestionSchema.table(
	"collector_node",
	{
		id: uuid("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		projectId: uuid("project_id").notNull(),
		enrollmentKeyId: uuid("enrollment_key_id").notNull(),
		machineId: text("machine_id").notNull(),
		hostname: text("hostname").notNull(),
		publicKey: text("public_key").notNull(),
		labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
		collectorVersion: text("collector_version").notNull().default(""),
		enrolledAt: timestamp("enrolled_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		// Deleted nodes stay revoked and hidden so the ingestion revocation list still
		// covers tokens issued before deletion.
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "collector_node_enrollment_key_fk",
			columns: [table.enrollmentKeyId, table.projectId, table.organizationId],
			foreignColumns: [
				enrollmentKey.id,
				enrollmentKey.projectId,
				enrollmentKey.organizationId,
			],
		}).onDelete("cascade"),
		uniqueIndex("collector_node_active_machine")
			.on(table.projectId, table.machineId)
			.where(sql`${table.revokedAt} IS NULL`),
		index("collector_node_project_idx").on(
			table.projectId,
			table.organizationId,
		),
		index("collector_node_revoked_idx").on(table.revokedAt),
		check(
			"collector_node_machine",
			sql`app.collector_identifier_valid(${table.machineId}) AND ${table.machineId} NOT LIKE 'recount.local.%'`,
		),
		check(
			"collector_node_hostname",
			sql`length(btrim(${table.hostname})) BETWEEN 1 AND 255`,
		),
		check(
			"collector_node_public_key",
			sql`${table.publicKey} ~ '^[A-Za-z0-9_-]{43}$'`,
		),
		check(
			"collector_node_version",
			sql`length(${table.collectorVersion}) <= 64`,
		),
		check(
			"collector_node_deleted_revoked",
			sql`${table.deletedAt} IS NULL OR ${table.revokedAt} IS NOT NULL`,
		),
		check(
			"collector_node_labels",
			sql`cardinality(${table.labels}) <= 20 AND array_position(${table.labels}, NULL) IS NULL`,
		),
	],
);
