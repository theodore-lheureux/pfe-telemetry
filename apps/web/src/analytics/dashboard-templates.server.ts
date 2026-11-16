import { and, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { dashboard, dashboardTile, savedInsight } from "../db/schema";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import {
	builtInDashboardTemplates,
	type CreateTemplateDashboardInput,
} from "./dashboard-templates";
import { getDashboard } from "./dashboards.server";
import { parseSavedDraft } from "./saved-insights-validation";

type Database = ReturnType<typeof getDatabase>;

/** Atomically creates ordinary insights and tiles; a retried request never reseeds them. */
export async function createTemplateDashboard(
	database: Database,
	actor: Actor,
	input: CreateTemplateDashboardInput,
) {
	await requireProject(database, actor, input, "write");
	const found = builtInDashboardTemplates().find(
		(template) => template.id === input.templateId,
	);
	if (!found)
		throw new InputError("INVALID_QUERY", "Unknown dashboard template");
	const template = found.template;
	await database.transaction(async (transaction) => {
		const [created] = await transaction
			.insert(dashboard)
			.values({
				id: input.dashboardId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				name: template.name,
				description: template.description,
				filters: JSON.parse(template.filters),
				createdBy: actor.id,
				updatedBy: actor.id,
			})
			.onConflictDoNothing()
			.returning({ id: dashboard.id });
		if (!created) {
			const [existing] = await transaction
				.select({ id: dashboard.id })
				.from(dashboard)
				.where(
					and(
						eq(dashboard.id, input.dashboardId),
						eq(dashboard.organizationId, input.organizationId),
						eq(dashboard.projectId, input.projectId),
					),
				);
			if (!existing)
				throw new OperationError("CONFLICT", "Dashboard ID already in use");
			return;
		}
		for (const [position, tile] of template.tiles.entries()) {
			const [insight] = await transaction
				.insert(savedInsight)
				.values({
					organizationId: input.organizationId,
					projectId: input.projectId,
					name: tile.insight.name,
					description: tile.insight.description,
					draft: JSON.parse(parseSavedDraft(tile.insight.draft)),
					createdBy: actor.id,
					updatedBy: actor.id,
				})
				.returning({ id: savedInsight.id });
			await transaction.insert(dashboardTile).values({
				dashboardId: input.dashboardId,
				projectId: input.projectId,
				insightId: insight.id,
				position,
				width: tile.width,
				height: tile.height,
				column: tile.column,
				options: { ...tile.options },
				overrides: JSON.parse(tile.overrides),
			});
		}
	});
	return getDashboard(database, actor, input);
}
