import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	jsonb,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { appSchema, user } from "./auth-schema";
import { project } from "./projects-schema";

// Insights saved from the editor. The draft is the editor's own JSON form, validated
// by the application; the database bounds its size and the name's length.

export const savedInsight = appSchema.table(
	"saved_insight",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
		draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "saved_insight_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		index("saved_insight_project_updated_idx").on(
			table.projectId,
			table.updatedAt,
		),
		check(
			"saved_insight_name_bounded",
			sql`char_length(${table.name}) BETWEEN 1 AND 120`,
		),
		check(
			"saved_insight_tags_bounded",
			sql`cardinality(${table.tags}) <= 20 AND array_position(${table.tags}, NULL) IS NULL`,
		),
		check(
			"saved_insight_description_bounded",
			sql`char_length(${table.description}) <= 1000`,
		),
		check(
			"saved_insight_draft_bounded",
			sql`jsonb_typeof(${table.draft}) = 'object' AND octet_length(${table.draft}::text) <= 32768`,
		),
	],
);
