import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { ExplorerColumn } from "../activity/columns";
import { appSchema, member } from "./auth-schema";
import { project } from "./projects-schema";

// Explorer column sets: a project default chosen by project administrators, and each
// member's own choice, which takes precedence. Both are validated by the application;
// the database bounds their size.

export const explorerColumnDefault = appSchema.table(
	"explorer_column_default",
	{
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		columns: jsonb("columns").$type<ExplorerColumn[]>().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.organizationId] }),
		foreignKey({
			name: "explorer_column_default_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"explorer_column_default_bounded",
			sql`jsonb_typeof(${table.columns}) = 'array' AND jsonb_array_length(${table.columns}) BETWEEN 1 AND 20`,
		),
	],
);

export const explorerColumnPreference = appSchema.table(
	"explorer_column_preference",
	{
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		memberId: text("member_id").notNull(),
		columns: jsonb("columns").$type<ExplorerColumn[]>().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.memberId] }),
		foreignKey({
			name: "explorer_column_preference_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "explorer_column_preference_member_fk",
			columns: [table.memberId, table.organizationId],
			foreignColumns: [member.id, member.organizationId],
		}).onDelete("cascade"),
		check(
			"explorer_column_preference_bounded",
			sql`jsonb_typeof(${table.columns}) = 'array' AND jsonb_array_length(${table.columns}) BETWEEN 1 AND 20`,
		),
	],
);
