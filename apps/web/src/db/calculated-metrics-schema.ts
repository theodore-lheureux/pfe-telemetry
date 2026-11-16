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
import type { CalculationDefinition } from "../analytics/calculated-metrics";
import { appSchema, user } from "./auth-schema";
import { project } from "./projects-schema";

export const calculatedMetric = appSchema.table(
	"calculated_metric",
	{
		id: uuid("id").notNull(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		definition: jsonb("definition").$type<CalculationDefinition>().notNull(),
		createdBy: text("created_by").references(() => user.id, {
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
		primaryKey({ columns: [table.projectId, table.id] }),
		foreignKey({
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"calculated_metric_name_bounded",
			sql`char_length(${table.name}) BETWEEN 1 AND 120`,
		),
		check(
			"calculated_metric_description_bounded",
			sql`char_length(${table.description}) <= 1000`,
		),
		check(
			"calculated_metric_definition_bounded",
			sql`jsonb_typeof(${table.definition}) = 'object' AND octet_length(${table.definition}::text) <= 16384`,
		),
	],
);
