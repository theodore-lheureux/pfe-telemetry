import type { ProjectReference } from "../organizations/contracts";

// Saved insights travel as the editor's draft text, the same form as the `q` URL
// parameter, so the editor opens them without another conversion.

export const MAX_INSIGHT_NAME = 120;
export const MAX_INSIGHT_DESCRIPTION = 1000;

/** Who created an insight, enough to show their avatar and name. */
export interface InsightPerson {
	id: string;
	name: string;
	email: string;
	image: string | null;
	gravatarUrl: string;
}

export const MAX_DELETED_INSIGHTS = 100;

export interface SavedInsight {
	id: string;
	name: string;
	description: string;
	tags: string[];
	draft: string;
	createdAt: Date;
	/** Null when that account was deleted. */
	createdBy: InsightPerson | null;
	updatedAt: Date;
	/** Who last saved it; null when that account was deleted. */
	updatedBy: string | null;
}

export type SavedInsightReference = ProjectReference & { insightId: string };
export type DeleteInsightsInput = ProjectReference & { insightIds: string[] };

export const TAG_MODES = ["add", "remove", "replace"] as const;
export type TagMode = (typeof TAG_MODES)[number];
export type UpdateInsightTagsInput = DeleteInsightsInput & {
	mode: TagMode;
	tags: string[];
};

export type SaveInsightInput = SavedInsightReference & {
	name: string;
	/** Omitted to keep the stored description. */
	description?: string;
	/** Replaces the stored tags; omitted to keep them. */
	tags?: string[];
	/** Omitted to rename without changing what the insight shows. */
	draft?: string;
};
