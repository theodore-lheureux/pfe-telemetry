import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { appSchema, user } from "./auth-schema";
import { project } from "./projects-schema";

export const definitionStatus = appSchema.enum("definition_status", [
	"verified",
	"hidden",
]);
export const attributeScope = appSchema.enum("attribute_scope", [
	"point",
	"resource",
]);

// What members add to collected metrics and attributes. ClickHouse discovers the
// definitions themselves; a row exists only once someone describes, tags or marks one.

export const metricAnnotation = appSchema.table(
	"metric_annotation",
	{
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		metricName: text("metric_name").notNull(),
		description: text("description").notNull().default(""),
		tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
		status: definitionStatus("status"),
		ownerId: text("owner_id").references(() => user.id, {
			onDelete: "set null",
		}),
		/** An attribute field, such as `attributes["cpu.mode"]`, the metric is usually split by. */
		defaultBreakdown: text("default_breakdown"),
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "metric_annotation_pk",
			columns: [table.projectId, table.metricName],
		}),
		foreignKey({
			name: "metric_annotation_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"metric_annotation_name_bounded",
			sql`char_length(${table.metricName}) BETWEEN 1 AND 255`,
		),
		check(
			"metric_annotation_description_bounded",
			sql`char_length(${table.description}) <= 1000`,
		),
		check(
			"metric_annotation_tags_bounded",
			sql`cardinality(${table.tags}) <= 20 AND array_position(${table.tags}, NULL) IS NULL`,
		),
		check(
			"metric_annotation_breakdown_bounded",
			sql`char_length(${table.defaultBreakdown}) <= 300`,
		),
	],
);

export const attributeAnnotation = appSchema.table(
	"attribute_annotation",
	{
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		scope: attributeScope("scope").notNull(),
		attributeKey: text("attribute_key").notNull(),
		description: text("description").notNull().default(""),
		tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
		status: definitionStatus("status"),
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "attribute_annotation_pk",
			columns: [table.projectId, table.scope, table.attributeKey],
		}),
		foreignKey({
			name: "attribute_annotation_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"attribute_annotation_key_bounded",
			sql`char_length(${table.attributeKey}) BETWEEN 1 AND 255`,
		),
		check(
			"attribute_annotation_description_bounded",
			sql`char_length(${table.description}) <= 1000`,
		),
		check(
			"attribute_annotation_tags_bounded",
			sql`cardinality(${table.tags}) <= 20 AND array_position(${table.tags}, NULL) IS NULL`,
		),
	],
);
