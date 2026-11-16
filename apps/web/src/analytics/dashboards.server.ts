import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { getDatabase } from "../db/client.server";
import {
	dashboard,
	dashboardTile,
	projectHome,
	savedInsight,
	user,
} from "../db/schema";
import { OperationError } from "../lib/operation-error";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import { nodeNames } from "./analytics.server";
import { lockCalculationReferences } from "./calculated-references.server";
import {
	type AddTilesInput,
	type CopyTileInput,
	type Dashboard,
	type DashboardReference,
	type DashboardSummary,
	DEFAULT_TILE,
	type DuplicateTileInput,
	type LayoutInput,
	MAX_DASHBOARD_TILES,
	type RemoveTileInput,
	type SaveDashboardInput,
	type TileHeight,
	type TileOptions,
	type TileReference,
	type TileWidth,
	type UpdateTileInput,
} from "./dashboards";
import { decodeDraft } from "./insight/draft";
import { person } from "./saved-insights.server";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const MAX_LISTED = 500;

const creator = alias(user, "creator");
const insightCreator = alias(user, "insight_creator");
const insightEditor = alias(user, "insight_editor");

// Every lookup is qualified by organization and project, never by dashboard ID alone.
function inProject(reference: ProjectReference) {
	return and(
		eq(dashboard.organizationId, reference.organizationId),
		eq(dashboard.projectId, reference.projectId),
	);
}

function thisDashboard(input: DashboardReference) {
	return and(inProject(input), eq(dashboard.id, input.dashboardId));
}

/** The project's dashboards, most recently changed first. Any project reader may list them. */
export async function listDashboards(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
): Promise<DashboardSummary[]> {
	await requireProject(database, actor, reference);
	const rows = await database
		.select({
			id: dashboard.id,
			name: dashboard.name,
			description: dashboard.description,
			createdAt: dashboard.createdAt,
			updatedAt: dashboard.updatedAt,
			tileCount: count(dashboardTile.id),
			creatorId: creator.id,
			creatorName: creator.name,
			creatorEmail: creator.email,
			creatorImage: creator.image,
		})
		.from(dashboard)
		.leftJoin(creator, eq(creator.id, dashboard.createdBy))
		.leftJoin(dashboardTile, eq(dashboardTile.dashboardId, dashboard.id))
		.where(inProject(reference))
		.groupBy(dashboard.id, creator.id)
		.orderBy(desc(dashboard.updatedAt))
		.limit(MAX_LISTED);
	return rows.map(
		({ creatorId, creatorName, creatorEmail, creatorImage, ...row }) => ({
			...row,
			createdBy: person(creatorId, creatorName, creatorEmail, creatorImage),
		}),
	);
}

async function readDashboard(
	database: Database | Transaction,
	input: DashboardReference,
): Promise<Dashboard> {
	const [row] = await database
		.select({
			id: dashboard.id,
			name: dashboard.name,
			description: dashboard.description,
			filters: dashboard.filters,
			createdAt: dashboard.createdAt,
			updatedAt: dashboard.updatedAt,
			creatorId: creator.id,
			creatorName: creator.name,
			creatorEmail: creator.email,
			creatorImage: creator.image,
		})
		.from(dashboard)
		.leftJoin(creator, eq(creator.id, dashboard.createdBy))
		.where(thisDashboard(input));
	if (!row) throw new OperationError("NOT_FOUND", "Dashboard not found");
	const tiles = await database
		.select({
			id: dashboardTile.id,
			width: dashboardTile.width,
			height: dashboardTile.height,
			column: dashboardTile.column,
			overrides: dashboardTile.overrides,
			options: dashboardTile.options,
			insightId: savedInsight.id,
			name: savedInsight.name,
			description: savedInsight.description,
			draft: savedInsight.draft,
			createdAt: savedInsight.createdAt,
			updatedAt: savedInsight.updatedAt,
			creatorId: insightCreator.id,
			creatorName: insightCreator.name,
			creatorEmail: insightCreator.email,
			creatorImage: insightCreator.image,
			editorId: insightEditor.id,
			editorName: insightEditor.name,
			editorEmail: insightEditor.email,
			editorImage: insightEditor.image,
		})
		.from(dashboardTile)
		.innerJoin(
			savedInsight,
			and(
				eq(savedInsight.id, dashboardTile.insightId),
				eq(savedInsight.projectId, dashboardTile.projectId),
			),
		)
		.leftJoin(insightCreator, eq(insightCreator.id, savedInsight.createdBy))
		.leftJoin(insightEditor, eq(insightEditor.id, savedInsight.updatedBy))
		.where(eq(dashboardTile.dashboardId, row.id))
		.orderBy(asc(dashboardTile.position));
	const { creatorId, creatorName, creatorEmail, creatorImage, ...fields } = row;
	return {
		...fields,
		filters: JSON.stringify(fields.filters),
		createdBy: person(creatorId, creatorName, creatorEmail, creatorImage),
		tiles: tiles.map((tile) => ({
			id: tile.id,
			width: tile.width as TileWidth,
			height: tile.height as TileHeight,
			column: tile.column,
			overrides: JSON.stringify(tile.overrides),
			options: tile.options as TileOptions,
			insight: {
				id: tile.insightId,
				name: tile.name,
				description: tile.description,
				draft: JSON.stringify(tile.draft),
				createdAt: tile.createdAt,
				createdBy: person(
					tile.creatorId,
					tile.creatorName,
					tile.creatorEmail,
					tile.creatorImage,
				),
				updatedAt: tile.updatedAt,
				updatedBy: person(
					tile.editorId,
					tile.editorName,
					tile.editorEmail,
					tile.editorImage,
				),
			},
		})),
	};
}

export async function getDashboard(
	database: Database,
	actor: Actor,
	input: DashboardReference,
) {
	await requireProject(database, actor, input);
	const [found, nodes] = await Promise.all([
		readDashboard(database, input),
		nodeNames(database, input),
	]);
	return { ...found, nodes };
}

/**
 * Creates the dashboard under the caller-chosen ID, or updates it when it exists in
 * this project, so a retried create stores one dashboard.
 */
export async function saveDashboard(
	database: Database,
	actor: Actor,
	input: SaveDashboardInput,
) {
	await requireProject(database, actor, input, "write");
	const filters =
		input.filters === undefined ? {} : { filters: JSON.parse(input.filters) };
	const [updated] = await database
		.update(dashboard)
		.set({
			name: input.name,
			...(input.description === undefined
				? {}
				: { description: input.description }),
			...filters,
			updatedBy: actor.id,
			updatedAt: new Date(),
		})
		.where(thisDashboard(input))
		.returning({ id: dashboard.id });
	if (!updated) {
		const [created] = await database
			.insert(dashboard)
			.values({
				id: input.dashboardId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				name: input.name,
				description: input.description ?? "",
				...filters,
				createdBy: actor.id,
				updatedBy: actor.id,
			})
			.onConflictDoNothing()
			.returning({ id: dashboard.id });
		if (!created) {
			const [existing] = await database
				.select({ id: dashboard.id })
				.from(dashboard)
				.where(thisDashboard(input));
			if (!existing)
				throw new OperationError("CONFLICT", "Dashboard ID already in use");
		}
	}
	return readDashboard(database, input);
}

export async function deleteDashboard(
	database: Database,
	actor: Actor,
	input: DashboardReference,
) {
	await requireProject(database, actor, input, "write");
	const deleted = await database
		.delete(dashboard)
		.where(thisDashboard(input))
		.returning({ id: dashboard.id });
	if (!deleted.length)
		throw new OperationError("NOT_FOUND", "Dashboard not found");
	return { deleted: deleted.length };
}

/** Locks the dashboard so concurrent layout changes apply one after another. */
async function lockDashboard(
	transaction: Transaction,
	input: DashboardReference,
) {
	const [row] = await transaction
		.select({ id: dashboard.id })
		.from(dashboard)
		.where(thisDashboard(input))
		.for("update");
	if (!row) throw new OperationError("NOT_FOUND", "Dashboard not found");
}

async function touch(
	transaction: Transaction,
	actor: Actor,
	input: DashboardReference,
) {
	await transaction
		.update(dashboard)
		.set({ updatedBy: actor.id, updatedAt: new Date() })
		.where(thisDashboard(input));
}

/** Appends tiles for this project's insights; insights from elsewhere are not found. */
export async function addTiles(
	database: Database,
	actor: Actor,
	input: AddTilesInput,
) {
	await requireProject(database, actor, input, "write");
	await database.transaction(async (transaction) => {
		await lockDashboard(transaction, input);
		const insights = await transaction
			.select({ id: savedInsight.id })
			.from(savedInsight)
			.where(
				and(
					eq(savedInsight.organizationId, input.organizationId),
					eq(savedInsight.projectId, input.projectId),
					inArray(savedInsight.id, input.insightIds),
				),
			);
		if (insights.length !== input.insightIds.length)
			throw new OperationError("NOT_FOUND", "Insight not found");
		const [current] = await transaction
			.select({ tiles: count(), last: max(dashboardTile.position) })
			.from(dashboardTile)
			.where(eq(dashboardTile.dashboardId, input.dashboardId));
		if (current.tiles + input.insightIds.length > MAX_DASHBOARD_TILES)
			throw new OperationError(
				"CONFLICT",
				`A dashboard cannot have more than ${MAX_DASHBOARD_TILES} tiles`,
			);
		const start = (current.last ?? -1) + 1;
		await transaction.insert(dashboardTile).values(
			input.insightIds.map((insightId, index) => ({
				dashboardId: input.dashboardId,
				projectId: input.projectId,
				insightId,
				position: start + index,
				...DEFAULT_TILE,
			})),
		);
		await touch(transaction, actor, input);
	});
	return readDashboard(database, input);
}

/**
 * Applies a new order and sizes. The layout must list exactly the dashboard's tiles,
 * so a change made from a stale page is refused instead of dropping tiles.
 */
export async function updateLayout(
	database: Database,
	actor: Actor,
	input: LayoutInput,
) {
	await requireProject(database, actor, input, "write");
	await database.transaction(async (transaction) => {
		await lockDashboard(transaction, input);
		const tiles = await transaction
			.select({ id: dashboardTile.id })
			.from(dashboardTile)
			.where(eq(dashboardTile.dashboardId, input.dashboardId));
		const known = new Set(tiles.map((tile) => tile.id));
		if (
			tiles.length !== input.tiles.length ||
			input.tiles.some((tile) => !known.has(tile.id))
		)
			throw new OperationError(
				"CONFLICT",
				"The dashboard changed; reload it and try again",
			);
		for (const [position, tile] of input.tiles.entries())
			await transaction
				.update(dashboardTile)
				.set({
					position,
					width: tile.width,
					height: tile.height,
					column: tile.column,
				})
				.where(
					and(
						eq(dashboardTile.dashboardId, input.dashboardId),
						eq(dashboardTile.id, tile.id),
					),
				);
		await touch(transaction, actor, input);
	});
	return readDashboard(database, input);
}

export async function removeTile(
	database: Database,
	actor: Actor,
	input: RemoveTileInput,
) {
	await requireProject(database, actor, input, "write");
	await database.transaction(async (transaction) => {
		await lockDashboard(transaction, input);
		const removed = await transaction
			.delete(dashboardTile)
			.where(
				and(
					eq(dashboardTile.dashboardId, input.dashboardId),
					eq(dashboardTile.id, input.tileId),
				),
			)
			.returning({ id: dashboardTile.id });
		if (!removed.length)
			throw new OperationError("NOT_FOUND", "Tile not found");
		await touch(transaction, actor, input);
	});
	return readDashboard(database, input);
}

function thisTile(input: TileReference) {
	return and(
		eq(dashboardTile.dashboardId, input.dashboardId),
		eq(dashboardTile.projectId, input.projectId),
		eq(dashboardTile.id, input.tileId),
	);
}

async function nextPosition(transaction: Transaction, dashboardId: string) {
	const [current] = await transaction
		.select({ tiles: count(), last: max(dashboardTile.position) })
		.from(dashboardTile)
		.where(eq(dashboardTile.dashboardId, dashboardId));
	if (current.tiles >= MAX_DASHBOARD_TILES)
		throw new OperationError(
			"CONFLICT",
			`A dashboard cannot have more than ${MAX_DASHBOARD_TILES} tiles`,
		);
	return (current.last ?? -1) + 1;
}

/** Changes one tile's overrides or options. */
export async function updateTile(
	database: Database,
	actor: Actor,
	input: UpdateTileInput,
) {
	await requireProject(database, actor, input, "write");
	await database.transaction(async (transaction) => {
		await lockDashboard(transaction, input);
		const updated = await transaction
			.update(dashboardTile)
			.set({
				...(input.overrides === undefined
					? {}
					: { overrides: JSON.parse(input.overrides) }),
				...(input.options === undefined
					? {}
					: { options: { ...input.options } }),
			})
			.where(thisTile(input))
			.returning({ id: dashboardTile.id });
		if (!updated.length)
			throw new OperationError("NOT_FOUND", "Tile not found");
		await touch(transaction, actor, input);
	});
	return readDashboard(database, input);
}

/**
 * Adds a tile to another dashboard of the same project, with its size, overrides and
 * options, and removes it from this one when moving.
 */
export async function copyTile(
	database: Database,
	actor: Actor,
	input: CopyTileInput,
) {
	await requireProject(database, actor, input, "write");
	const target = { ...input, dashboardId: input.targetDashboardId };
	await database.transaction(async (transaction) => {
		// Locked in ID order, so two opposite moves cannot wait on each other.
		for (const locked of [input, target].sort((a, b) =>
			a.dashboardId < b.dashboardId ? -1 : 1,
		))
			await lockDashboard(transaction, locked);
		const [tile] = await transaction
			.select()
			.from(dashboardTile)
			.where(thisTile(input));
		if (!tile) throw new OperationError("NOT_FOUND", "Tile not found");
		const position = await nextPosition(transaction, target.dashboardId);
		await transaction.insert(dashboardTile).values({
			dashboardId: target.dashboardId,
			projectId: input.projectId,
			insightId: tile.insightId,
			position,
			width: tile.width,
			height: tile.height,
			overrides: tile.overrides,
			options: tile.options,
		});
		await touch(transaction, actor, target);
		if (input.move) {
			await transaction.delete(dashboardTile).where(thisTile(input));
			await touch(transaction, actor, input);
		}
	});
	return readDashboard(database, input);
}

/** Saves a copy of a tile's insight under a new name and adds it as a tile here. */
export async function duplicateTile(
	database: Database,
	actor: Actor,
	input: DuplicateTileInput,
) {
	await requireProject(database, actor, input, "write");
	await database.transaction(async (transaction) => {
		await lockDashboard(transaction, input);
		const [tile] = await transaction
			.select({
				width: dashboardTile.width,
				height: dashboardTile.height,
				overrides: dashboardTile.overrides,
				options: dashboardTile.options,
				description: savedInsight.description,
				tags: savedInsight.tags,
				draft: savedInsight.draft,
			})
			.from(dashboardTile)
			.innerJoin(
				savedInsight,
				and(
					eq(savedInsight.id, dashboardTile.insightId),
					eq(savedInsight.projectId, dashboardTile.projectId),
				),
			)
			.where(thisTile(input));
		if (!tile) throw new OperationError("NOT_FOUND", "Tile not found");
		await lockCalculationReferences(
			transaction,
			input,
			decodeDraft(JSON.stringify(tile.draft)),
		);
		const position = await nextPosition(transaction, input.dashboardId);
		const [copy] = await transaction
			.insert(savedInsight)
			.values({
				projectId: input.projectId,
				organizationId: input.organizationId,
				name: input.name,
				description: tile.description,
				tags: tile.tags,
				draft: tile.draft,
				createdBy: actor.id,
				updatedBy: actor.id,
			})
			.returning({ id: savedInsight.id });
		await transaction.insert(dashboardTile).values({
			dashboardId: input.dashboardId,
			projectId: input.projectId,
			insightId: copy.id,
			position,
			width: tile.width,
			height: tile.height,
			overrides: tile.overrides,
			options: tile.options,
		});
		await touch(transaction, actor, input);
	});
	return readDashboard(database, input);
}

/** The project's chosen home dashboard, if any, without loading it. */
export async function getProjectHomeChoice(
	database: Database,
	actor: Actor,
	input: ProjectReference,
) {
	await requireProject(database, actor, input);
	const [row] = await database
		.select({ dashboardId: dashboard.id, name: dashboard.name })
		.from(projectHome)
		.innerJoin(
			dashboard,
			and(
				eq(dashboard.id, projectHome.dashboardId),
				eq(dashboard.projectId, projectHome.projectId),
			),
		)
		.where(
			and(
				eq(projectHome.organizationId, input.organizationId),
				eq(projectHome.projectId, input.projectId),
			),
		)
		.limit(1);
	return row ?? null;
}

/** The dashboard the project opens on, loaded, or null for the Node health template. */
export async function getProjectHome(
	database: Database,
	actor: Actor,
	input: ProjectReference,
) {
	const choice = await getProjectHomeChoice(database, actor, input);
	if (!choice) return null;
	return getDashboard(database, actor, {
		...input,
		dashboardId: choice.dashboardId,
	});
}

/** Opens the project on a saved dashboard, or on the Node health template with null. */
export async function setProjectHome(
	database: Database,
	actor: Actor,
	input: ProjectReference & { dashboardId: string | null },
) {
	await requireProject(database, actor, input, "admin");
	const project = and(
		eq(projectHome.organizationId, input.organizationId),
		eq(projectHome.projectId, input.projectId),
	);
	if (input.dashboardId === null) {
		await database.delete(projectHome).where(project);
		return { dashboardId: null };
	}
	const [found] = await database
		.select({ id: dashboard.id })
		.from(dashboard)
		.where(thisDashboard({ ...input, dashboardId: input.dashboardId }))
		.limit(1);
	if (!found) throw new OperationError("NOT_FOUND", "Dashboard not found");
	await database
		.insert(projectHome)
		.values({
			projectId: input.projectId,
			organizationId: input.organizationId,
			dashboardId: found.id,
			updatedBy: actor.id,
		})
		.onConflictDoUpdate({
			target: projectHome.projectId,
			set: {
				dashboardId: found.id,
				updatedBy: actor.id,
				updatedAt: new Date(),
			},
		});
	return { dashboardId: found.id };
}
