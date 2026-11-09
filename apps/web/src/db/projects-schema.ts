import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	integer,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { appSchema, member, organization, user } from "./auth-schema";

export const projectRole = appSchema.enum("project_role", [
	"viewer",
	"member",
	"admin",
]);

export const project = appSchema.table(
	"project",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
		projectGroup: text("project_group").notNull().default(""),
		timeZone: text("time_zone").notNull().default("UTC"),
		weekStartsOn: integer("week_starts_on").notNull().default(0),
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
		check(
			"project_tags_bounded",
			sql`cardinality(${table.tags}) <= 20 AND array_position(${table.tags}, NULL) IS NULL`,
		),
		check("project_group_bounded", sql`length(${table.projectGroup}) <= 80`),
		check(
			"project_time_zone_bounded",
			sql`length(${table.timeZone}) BETWEEN 1 AND 100`,
		),
		check(
			"project_week_start_valid",
			sql`${table.weekStartsOn} BETWEEN 0 AND 6`,
		),
		unique("project_organization_slug_unique").on(
			table.organizationId,
			table.slug,
		),
		unique("project_id_organization_unique").on(table.id, table.organizationId),
	],
);

export const projectMember = appSchema.table(
	"project_member",
	{
		projectId: uuid("project_id").notNull(),
		organizationId: text("organization_id").notNull(),
		memberId: text("member_id").notNull(),
		role: projectRole("role").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.memberId] }),
		foreignKey({
			name: "project_member_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "project_member_member_organization_fk",
			columns: [table.memberId, table.organizationId],
			foreignColumns: [member.id, member.organizationId],
		}).onDelete("cascade"),
	],
);

export const organizationOwnerGuard = appSchema.table(
	"organization_owner_guard",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		ownerCount: integer("owner_count").notNull(),
	},
	(table) => [
		check("organization_must_retain_owner", sql`${table.ownerCount} > 0`),
	],
);
