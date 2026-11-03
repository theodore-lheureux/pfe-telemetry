import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { appSchema, user } from "./auth-schema";
import { project } from "./projects-schema";

export const execution = appSchema.table(
	"execution",
	{
		id: uuid("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		projectId: uuid("project_id").notNull(),
		name: text("name").notNull(),
		sourceId: text("source_id").notNull(),
		hostId: text("host_id"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "execution_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"execution_name",
			sql`length(btrim(${table.name})) BETWEEN 1 AND 120`,
		),
		check(
			"execution_window",
			sql`${table.startedAt} >= timestamptz '1970-01-01' AND ${table.endedAt} <= timestamptz '2101-01-01' AND ${table.endedAt} > ${table.startedAt} AND ${table.endedAt} <= ${table.startedAt} + interval '7 days'`,
		),
		check(
			"execution_source",
			sql`app.collector_identifier_valid(${table.sourceId})`,
		),
		check(
			"execution_host",
			sql`${table.hostId} IS NULL OR app.collector_identifier_valid(${table.hostId})`,
		),
		index("execution_project_id_idx").on(table.projectId, table.id),
	],
);
