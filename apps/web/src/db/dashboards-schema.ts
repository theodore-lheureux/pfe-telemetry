import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	smallint,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { DashboardTemplate } from "../analytics/dashboard-templates";
import { appSchema, user } from "./auth-schema";
import { savedInsight } from "./insights-schema";
import { project } from "./projects-schema";

// Dashboards arrange a project's saved insights as tiles. Tiles reference the
// dashboard and the insight together with the project, so a tile can never show
// another project's insight.

export const dashboardTemplateSnapshot = appSchema.table(
	"dashboard_template",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		definition: jsonb("definition").$type<DashboardTemplate>().notNull(),
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "dashboard_template_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		index("dashboard_template_project_idx").on(table.projectId),
		check(
			"dashboard_template_definition_bounded",
			sql`jsonb_typeof(${table.definition}) = 'object' AND octet_length(${table.definition}::text) <= 524288`,
		),
	],
);

export const dashboard = appSchema.table(
	"dashboard",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		/** Overrides every tile uses, as validated `DashboardFilters`. */
		filters: jsonb("filters")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
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
			name: "dashboard_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		unique("dashboard_id_project_unique").on(table.id, table.projectId),
		index("dashboard_project_updated_idx").on(table.projectId, table.updatedAt),
		check(
			"dashboard_name_bounded",
			sql`char_length(${table.name}) BETWEEN 1 AND 120`,
		),
		check(
			"dashboard_description_bounded",
			sql`char_length(${table.description}) <= 1000`,
		),
		check(
			"dashboard_filters_bounded",
			sql`jsonb_typeof(${table.filters}) = 'object' AND octet_length(${table.filters}::text) <= 8192`,
		),
	],
);

export const dashboardTile = appSchema.table(
	"dashboard_tile",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		dashboardId: uuid("dashboard_id").notNull(),
		projectId: uuid("project_id").notNull(),
		insightId: uuid("insight_id").notNull(),
		position: integer("position").notNull(),
		/** Columns of a 12-column grid. */
		width: smallint("width").notNull(),
		/** Height in rows. */
		height: smallint("height").notNull(),
		/** The first grid column; null places the tile after the one before it. */
		column: smallint("column"),
		/** This tile's overrides, as validated `TileOverrides`. */
		overrides: jsonb("overrides")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** How the tile shows, as validated `TileOptions`. */
		options: jsonb("options")
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
	},
	(table) => [
		foreignKey({
			name: "dashboard_tile_dashboard_fk",
			columns: [table.dashboardId, table.projectId],
			foreignColumns: [dashboard.id, dashboard.projectId],
		}).onDelete("cascade"),
		// Deleting an insight removes it from every dashboard.
		foreignKey({
			name: "dashboard_tile_insight_fk",
			columns: [table.insightId, table.projectId],
			foreignColumns: [savedInsight.id, savedInsight.projectId],
		}).onDelete("cascade"),
		index("dashboard_tile_dashboard_idx").on(table.dashboardId, table.position),
		index("dashboard_tile_insight_idx").on(table.insightId),
		check("dashboard_tile_width_valid", sql`${table.width} BETWEEN 2 AND 12`),
		check("dashboard_tile_height_valid", sql`${table.height} BETWEEN 0 AND 6`),
		check(
			"dashboard_tile_settings_bounded",
			sql`jsonb_typeof(${table.overrides}) = 'object' AND octet_length(${table.overrides}::text) <= 8192 AND jsonb_typeof(${table.options}) = 'object' AND octet_length(${table.options}::text) <= 1024`,
		),
		check(
			"dashboard_tile_column_valid",
			sql`${table.column} IS NULL OR (${table.column} >= 1 AND ${table.column} + ${table.width} <= 13)`,
		),
	],
);

/** The dashboard a project opens on instead of the fleet overview, when one is chosen. */
export const projectHome = appSchema.table(
	"project_home",
	{
		projectId: uuid("project_id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		dashboardId: uuid("dashboard_id").notNull(),
		updatedBy: text("updated_by").references(() => user.id, {
			onDelete: "set null",
		}),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "project_home_project_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		// The dashboard must be the project's own; deleting it restores the overview.
		foreignKey({
			name: "project_home_dashboard_fk",
			columns: [table.dashboardId, table.projectId],
			foreignColumns: [dashboard.id, dashboard.projectId],
		}).onDelete("cascade"),
	],
);
