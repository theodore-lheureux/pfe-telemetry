import { parseName, parseUuid } from "../lib/input";
import { InputError } from "../lib/input-error";
import { MAX_TAGS, normalizeTag, withTags } from "../lib/tags";
import { parseProjectReference } from "../organizations/validation";
import {
	DEFAULT_DRAFT,
	decodeDraft,
	encodeDraft,
	MAX_DRAFT_LENGTH,
	toQuery,
} from "./insight/draft";
import {
	type DeleteInsightsInput,
	MAX_DELETED_INSIGHTS,
	MAX_INSIGHT_DESCRIPTION,
	type SavedInsightReference,
	type SaveInsightInput,
	TAG_MODES,
	type TagMode,
	type UpdateInsightTagsInput,
} from "./saved-insights";
import { parseQuery } from "./validation";

function record(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InputError("INVALID_QUERY", "Invalid request");
	return value as Record<string, unknown>;
}

export function parseSavedInsightReference(
	value: unknown,
): SavedInsightReference {
	return {
		...parseProjectReference(value),
		insightId: parseUuid(record(value).insightId, "insight identifier"),
	};
}

export function parseDeleteInsights(value: unknown): DeleteInsightsInput {
	const input = record(value);
	const ids = input.insightIds;
	if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETED_INSIGHTS)
		throw new InputError("INVALID_QUERY", "Invalid insight identifiers");
	return {
		...parseProjectReference(value),
		insightIds: [
			...new Set(ids.map((id) => parseUuid(id, "insight identifier"))),
		],
	};
}

/** Valid, distinct tags; case-insensitive duplicates keep their first spelling. */
export function parseTags(value: unknown) {
	if (!Array.isArray(value) || value.length > MAX_TAGS)
		throw new InputError("INVALID_QUERY", "Invalid tags");
	const tags = value.map(normalizeTag);
	if (tags.some((tag) => tag === null))
		throw new InputError("INVALID_QUERY", "Invalid tag");
	return withTags([], tags as string[]) ?? [];
}

export function parseUpdateInsightTags(value: unknown): UpdateInsightTagsInput {
	const input = record(value);
	if (!TAG_MODES.includes(input.mode as TagMode))
		throw new InputError("INVALID_QUERY", "Invalid tag change");
	const tags = parseTags(input.tags);
	if (!tags.length && input.mode !== "replace")
		throw new InputError("INVALID_QUERY", "Choose a tag");
	return {
		...parseDeleteInsights(value),
		mode: input.mode as TagMode,
		tags,
	};
}

/**
 * A draft worth saving: readable, with a metric on every series, and a query the
 * analytics runner would accept. Returns its normalized text.
 */
export function parseSavedDraft(value: unknown) {
	if (typeof value !== "string" || value.length > MAX_DRAFT_LENGTH)
		throw new InputError("INVALID_QUERY", "Invalid insight");
	const draft = decodeDraft(value);
	if (draft === DEFAULT_DRAFT)
		throw new InputError("INVALID_QUERY", "Invalid insight");
	const query = toQuery(draft, new Date(), "UTC", "en");
	if (!query)
		throw new InputError("INVALID_QUERY", "Choose a metric for every series");
	parseQuery(query);
	return encodeDraft(draft);
}

export function parseSaveInsight(value: unknown): SaveInsightInput {
	const input = record(value);
	const name = parseName(input.name);
	const description =
		typeof input.description === "string" ? input.description.trim() : null;
	if (
		input.description !== undefined &&
		(description === null || description.length > MAX_INSIGHT_DESCRIPTION)
	)
		throw new InputError("INVALID_QUERY", "Invalid insight description");
	return {
		...parseSavedInsightReference(value),
		name,
		...(description === null ? {} : { description }),
		...(input.tags === undefined ? {} : { tags: parseTags(input.tags) }),
		...(input.draft === undefined
			? {}
			: { draft: parseSavedDraft(input.draft) }),
	};
}
