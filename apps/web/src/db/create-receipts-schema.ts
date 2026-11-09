import { sql } from "drizzle-orm";
import { check, foreignKey, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { appSchema, organization, user } from "./auth-schema";
import { project } from "./projects-schema";

export const createReceipt = appSchema.table(
	"create_receipt",
	{
		actorId: text("actor_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		requestId: uuid("request_id").notNull(),
		operation: text("operation").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: uuid("project_id"),
		inputHash: text("input_hash").notNull(),
		resourceId: uuid("resource_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.actorId, table.requestId] }),
		foreignKey({
			name: "create_receipt_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [project.id, project.organizationId],
		}).onDelete("cascade"),
		check(
			"create_receipt_operation_scope",
			sql`(${table.operation} = 'create-project' AND ${table.projectId} IS NULL) OR (${table.operation} = 'create-execution' AND ${table.projectId} IS NOT NULL)`,
		),
		check(
			"create_receipt_input_hash",
			sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
		),
	],
);
