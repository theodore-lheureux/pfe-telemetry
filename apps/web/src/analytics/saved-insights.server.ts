import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { gravatarUrl } from "../auth/avatar.server";
import type { getDatabase } from "../db/client.server";
import { savedInsight, user } from "../db/schema";
import { OperationError } from "../lib/operation-error";
import { MAX_TAGS, withoutTags, withTags } from "../lib/tags";
import { type Actor, requireProject } from "../organizations/access.server";
import type { ProjectReference } from "../organizations/contracts";
import type {
	DeleteInsightsInput,
	SavedInsight,
	SavedInsightReference,
	SaveInsightInput,
	TagMode,
	UpdateInsightTagsInput,
} from "./saved-insights";

type Database = ReturnType<typeof getDatabase>;
const MAX_LISTED = 500;

const creator = alias(user, "creator");
const columns = {
	id: savedInsight.id,
	name: savedInsight.name,
	description: savedInsight.description,
	tags: savedInsight.tags,
	draft: savedInsight.draft,
	createdAt: savedInsight.createdAt,
	updatedAt: savedInsight.updatedAt,
	updatedBy: user.name,
	creatorId: creator.id,
	creatorName: creator.name,
	creatorEmail: creator.email,
	creatorImage: creator.image,
};

function present({
	creatorId,
	creatorName,
	creatorEmail,
	creatorImage,
	...row
}: {
	id: string;
	name: string;
	description: string;
	tags: string[];
	draft: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
	updatedBy: string | null;
	creatorId: string | null;
	creatorName: string | null;
	creatorEmail: string | null;
	creatorImage: string | null;
}): SavedInsight {
	return {
		...row,
		draft: JSON.stringify(row.draft),
		createdBy:
			creatorId && creatorEmail
				? {
						id: creatorId,
						name: creatorName ?? "",
						email: creatorEmail,
						image: creatorImage,
						gravatarUrl: gravatarUrl(creatorEmail),
					}
				: null,
	};
}

// Every lookup is qualified by organization and project, never by insight ID alone.
function inProject(reference: ProjectReference) {
	return and(
		eq(savedInsight.organizationId, reference.organizationId),
		eq(savedInsight.projectId, reference.projectId),
	);
}

function selectInsights(database: Database) {
	return database
		.select(columns)
		.from(savedInsight)
		.leftJoin(user, eq(user.id, savedInsight.updatedBy))
		.leftJoin(creator, eq(creator.id, savedInsight.createdBy));
}

async function readInsight(database: Database, input: SavedInsightReference) {
	const [row] = await selectInsights(database).where(
		and(inProject(input), eq(savedInsight.id, input.insightId)),
	);
	if (!row) throw new OperationError("NOT_FOUND", "Insight not found");
	return present(row);
}

/** Saved insights, most recently changed first. Any project reader may list them. */
export async function listInsights(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
) {
	await requireProject(database, actor, reference);
	const rows = await selectInsights(database)
		.where(inProject(reference))
		.orderBy(desc(savedInsight.updatedAt))
		.limit(MAX_LISTED);
	return rows.map(present);
}

export async function getInsight(
	database: Database,
	actor: Actor,
	input: SavedInsightReference,
) {
	await requireProject(database, actor, input);
	return readInsight(database, input);
}

/**
 * Creates the insight under the caller-chosen ID, or updates it when it exists in this
 * project. A retried create therefore stores one insight, and an ID taken in another
 * project is a conflict rather than an overwrite.
 */
export async function saveInsight(
	database: Database,
	actor: Actor,
	input: SaveInsightInput,
) {
	await requireProject(database, actor, input, "write");
	const changes = {
		name: input.name,
		...(input.description === undefined
			? {}
			: { description: input.description }),
		...(input.tags === undefined ? {} : { tags: input.tags }),
		...(input.draft === undefined ? {} : { draft: JSON.parse(input.draft) }),
		updatedBy: actor.id,
		updatedAt: new Date(),
	};
	const [updated] = await database
		.update(savedInsight)
		.set(changes)
		.where(and(inProject(input), eq(savedInsight.id, input.insightId)))
		.returning({ id: savedInsight.id });
	if (!updated) {
		// Renaming needs an existing insight; only a full save creates one.
		if (input.draft === undefined)
			throw new OperationError("NOT_FOUND", "Insight not found");
		const [created] = await database
			.insert(savedInsight)
			.values({
				id: input.insightId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				name: input.name,
				description: input.description ?? "",
				tags: input.tags ?? [],
				draft: JSON.parse(input.draft),
				createdBy: actor.id,
				updatedBy: actor.id,
			})
			.onConflictDoNothing()
			.returning({ id: savedInsight.id });
		if (!created) {
			// A concurrent create of the same ID in this project already stored it.
			const existing = await selectInsights(database).where(
				and(inProject(input), eq(savedInsight.id, input.insightId)),
			);
			if (!existing.length)
				throw new OperationError("CONFLICT", "Insight ID already in use");
		}
	}
	return readInsight(database, input);
}

/** Deletes the given insights of this project; IDs from elsewhere are ignored. */
export async function deleteInsights(
	database: Database,
	actor: Actor,
	input: DeleteInsightsInput,
) {
	await requireProject(database, actor, input, "write");
	const deleted = await database
		.delete(savedInsight)
		.where(and(inProject(input), inArray(savedInsight.id, input.insightIds)))
		.returning({ id: savedInsight.id });
	if (!deleted.length)
		throw new OperationError("NOT_FOUND", "Insight not found");
	return { deleted: deleted.length };
}

function changedTags(current: string[], mode: TagMode, tags: string[]) {
	if (mode === "replace") return tags;
	if (mode === "remove") return withoutTags(current, tags);
	return withTags(current, tags);
}

/** Adds, removes or replaces tags on the given insights of this project together. */
export async function updateInsightTags(
	database: Database,
	actor: Actor,
	input: UpdateInsightTagsInput,
) {
	await requireProject(database, actor, input, "write");
	return database.transaction(async (transaction) => {
		const rows = await transaction
			.select({ id: savedInsight.id, tags: savedInsight.tags })
			.from(savedInsight)
			.where(and(inProject(input), inArray(savedInsight.id, input.insightIds)))
			.for("update");
		if (!rows.length)
			throw new OperationError("NOT_FOUND", "Insight not found");
		for (const row of rows) {
			const tags = changedTags(row.tags, input.mode, input.tags);
			if (!tags)
				throw new OperationError(
					"CONFLICT",
					`An insight cannot have more than ${MAX_TAGS} tags`,
				);
			await transaction
				.update(savedInsight)
				.set({ tags, updatedBy: actor.id, updatedAt: new Date() })
				.where(and(inProject(input), eq(savedInsight.id, row.id)));
		}
		return { updated: rows.length };
	});
}

/** Tags used by this project's saved insights, for suggestions. */
export async function listInsightTags(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
) {
	await requireProject(database, actor, reference);
	const tag = sql<string>`unnest(${savedInsight.tags})`;
	const rows = await database
		.selectDistinct({ tag })
		.from(savedInsight)
		.where(inProject(reference))
		.orderBy(asc(tag))
		.limit(MAX_LISTED);
	return rows.map((row) => row.tag);
}
