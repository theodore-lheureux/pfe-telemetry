import { and, desc, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import {
	dashboard,
	dashboardTemplateSnapshot,
	dashboardTile,
	savedInsight,
} from "../db/schema";
import { InputError } from "../lib/input-error";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { nodeNames } from "./analytics.server";
import { lockCalculationReferences } from "./calculated-references.server";
import {
	builtInDashboardTemplates,
	type CreateTemplateDashboardInput,
	dashboardTemplate,
	fillTemplateVariables,
	parameterizeTemplateNode,
	type SaveDashboardTemplateInput,
	type TemplateChoice,
} from "./dashboard-templates";
import { getDashboard } from "./dashboards.server";
import { decodeDraft } from "./insight/draft";
import { parseSavedDraft } from "./saved-insights-validation";

type Database = ReturnType<typeof getDatabase>;

function inProject(input: ProjectReference) {
	return and(
		eq(dashboardTemplateSnapshot.organizationId, input.organizationId),
		eq(dashboardTemplateSnapshot.projectId, input.projectId),
	);
}

export async function listDashboardTemplates(
	database: Database,
	actor: Actor,
	input: ProjectReference,
): Promise<TemplateChoice[]> {
	await requireProject(database, actor, input);
	const rows = await database
		.select()
		.from(dashboardTemplateSnapshot)
		.where(inProject(input))
		.orderBy(desc(dashboardTemplateSnapshot.createdAt))
		.limit(500);
	return rows.map((row) => ({
		id: row.id,
		scope: "project",
		template: row.definition,
	}));
}

export async function saveDashboardTemplate(
	database: Database,
	actor: Actor,
	input: SaveDashboardTemplateInput,
) {
	await requireProject(database, actor, input, "write");
	const source = dashboardTemplate(await getDashboard(database, actor, input));
	const definition = {
		...(input.parameterizeNode ? parameterizeTemplateNode(source) : source),
		name: input.name,
		description: input.description,
	};
	await database
		.insert(dashboardTemplateSnapshot)
		.values({
			id: input.templateId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			definition,
			createdBy: actor.id,
		})
		.onConflictDoNothing();
	const [stored] = await database
		.select({ id: dashboardTemplateSnapshot.id })
		.from(dashboardTemplateSnapshot)
		.where(
			and(inProject(input), eq(dashboardTemplateSnapshot.id, input.templateId)),
		);
	if (!stored)
		throw new OperationError("CONFLICT", "Template ID already in use");
	return stored;
}

/** Atomically creates ordinary insights and tiles; a retried request never reseeds them. */
export async function createTemplateDashboard(
	database: Database,
	actor: Actor,
	input: CreateTemplateDashboardInput,
) {
	await requireProject(database, actor, input, "write");
	let found = builtInDashboardTemplates().find(
		(template) => template.id === input.templateId,
	);
	if (!found) {
		const [row] = await database
			.select()
			.from(dashboardTemplateSnapshot)
			.where(
				and(
					inProject(input),
					eq(dashboardTemplateSnapshot.id, input.templateId),
				),
			);
		if (row) found = { id: row.id, scope: "project", template: row.definition };
	}
	if (!found)
		throw new OperationError("NOT_FOUND", "Dashboard template not found");
	const variables = found.template.variables ?? [];
	if (
		Object.keys(input.values ?? {}).some(
			(name) => !variables.some((variable) => variable.name === name),
		)
	)
		throw new InputError("INVALID_QUERY", "Unknown template variable");
	const node = input.values?.$node;
	if (
		node &&
		!(await nodeNames(database, input)).some(
			(candidate) => candidate.id === node,
		)
	)
		throw new InputError("INVALID_QUERY", "Unknown project node");
	const template = fillTemplateVariables(found.template, input.values);
	await database.transaction(async (transaction) => {
		const [created] = await transaction
			.insert(dashboard)
			.values({
				id: input.dashboardId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				name: input.name ?? template.name,
				description: input.description ?? template.description,
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
			const draft = parseSavedDraft(tile.insight.draft);
			await lockCalculationReferences(transaction, input, decodeDraft(draft));
			const [insight] = await transaction
				.insert(savedInsight)
				.values({
					organizationId: input.organizationId,
					projectId: input.projectId,
					name: tile.insight.name,
					description: tile.insight.description,
					draft: JSON.parse(draft),
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
