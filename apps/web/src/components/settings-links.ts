import { notFound } from "@tanstack/react-router";
import { organizationParams, projectParams } from "../organizations/route-data";

export const settingsSections = [
	"project",
	"project-customization",
	"project-members",
	"credentials",
	"project-danger",
	"organization",
	"organization-authentication",
	"organization-members",
	"organization-delete",
	"user",
	"appearance",
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export interface SettingsSearch {
	section: SettingsSection;
	organizationId?: string;
	projectId?: string;
}

export function parseSettingsSearch(
	search: Record<string, unknown>,
): SettingsSearch {
	const section = search.section ?? "user";
	if (!settingsSections.some((value) => value === section)) throw notFound();
	const organizationId =
		typeof search.organizationId === "string"
			? organizationParams({ organizationId: search.organizationId })
					.organizationId
			: undefined;
	const projectId =
		typeof search.projectId === "string" && organizationId
			? projectParams({ organizationId, projectId: search.projectId }).projectId
			: undefined;
	if (search.projectId !== undefined && !projectId) throw notFound();
	if (search.organizationId !== undefined && !organizationId) throw notFound();
	return { section: section as SettingsSection, organizationId, projectId };
}

export function settingsSearch(
	section: SettingsSection,
	selection: { organizationId?: string; projectId?: string } = {},
): SettingsSearch {
	return {
		section,
		organizationId: selection.organizationId,
		projectId: selection.projectId,
	};
}

export function settingsPath(
	section: SettingsSection,
	selection: { organizationId?: string; projectId?: string } = {},
) {
	const search = new URLSearchParams({ section });
	if (selection.organizationId)
		search.set("organizationId", selection.organizationId);
	if (selection.projectId) search.set("projectId", selection.projectId);
	return `/settings?${search}`;
}
