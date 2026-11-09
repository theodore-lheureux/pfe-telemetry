import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	unique,
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
		rootId: text("root_id").notNull(),
		rootKind: integer("root_kind").notNull(),
		maximumSubmissionAge: bigint("maximum_submission_age", { mode: "number" })
			.default(3600)
			.notNull(),
		allowedClockSkew: bigint("allowed_clock_skew", { mode: "number" })
			.default(60)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		rotatedAt: timestamp("rotated_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		unique("collector_credential_tenant_key").on(
			table.id,
			table.projectId,
			table.organizationId,
		),
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
			"collector_credential_root",
			sql`app.collector_identifier_valid(${table.rootId}) AND ${table.rootId} NOT LIKE 'recount.local.%' AND ${table.rootKind} BETWEEN 0 AND 8`,
		),
		check(
			"collector_credential_submission_age",
			sql`${table.maximumSubmissionAge} BETWEEN 1 AND 18446744073`,
		),
		check(
			"collector_credential_clock_skew",
			sql`${table.allowedClockSkew} >= 0 AND ${table.maximumSubmissionAge}::numeric + ${table.allowedClockSkew}::numeric <= 18446744073`,
		),
		check(
			"collector_credential_expiration",
			sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
		),
	],
);

export const collectorRootGrant = ingestionSchema.table(
	"collector_root_grant",
	{
		credentialId: uuid("credential_id").notNull(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		resourceId: text("resource_id").notNull(),
		resourceKind: integer("resource_kind").notNull(),
		adapter: text("adapter").notNull(),
		allowedLocalKinds: integer("allowed_local_kinds").array().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.credentialId, table.resourceId] }),
		foreignKey({
			name: "collector_root_grant_tenant_fk",
			columns: [table.credentialId, table.projectId, table.organizationId],
			foreignColumns: [
				collectorCredential.id,
				collectorCredential.projectId,
				collectorCredential.organizationId,
			],
		}).onDelete("cascade"),
		check(
			"collector_root_grant_resource",
			sql`app.collector_identifier_valid(${table.resourceId}) AND ${table.resourceId} NOT LIKE 'recount.local.%' AND ${table.resourceKind} BETWEEN 0 AND 8`,
		),
		check(
			"collector_root_grant_adapter",
			sql`${table.adapter} IN ('standard', 'linux') AND ${table.allowedLocalKinds} <@ ARRAY[2,3,4,6,8]::integer[] AND cardinality(${table.allowedLocalKinds}) <= 5 AND (${table.adapter} <> 'standard' OR cardinality(${table.allowedLocalKinds}) = 0)`,
		),
	],
);

export const collectorResourceGrant = ingestionSchema.table(
	"collector_resource_grant",
	{
		credentialId: uuid("credential_id").notNull(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		resourceId: text("resource_id").notNull(),
		resourceKind: integer("resource_kind").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.credentialId, table.resourceId] }),
		foreignKey({
			name: "collector_resource_grant_tenant_fk",
			columns: [table.credentialId, table.projectId, table.organizationId],
			foreignColumns: [
				collectorCredential.id,
				collectorCredential.projectId,
				collectorCredential.organizationId,
			],
		}).onDelete("cascade"),
		check(
			"collector_resource_grant_resource",
			sql`app.collector_identifier_valid(${table.resourceId}) AND ${table.resourceId} NOT LIKE 'recount.local.%' AND ${table.resourceKind} BETWEEN 0 AND 8`,
		),
	],
);
