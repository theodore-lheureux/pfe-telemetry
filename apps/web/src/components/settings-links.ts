import { notFound } from "@tanstack/react-router";
import { organizationParams, projectParams } from "../organizations/route-data";

export type SettingsScope = "project" | "organization" | "user";
export const settingsScopes = {
	project: "project",
	"project-customization": "project",
	"project-members": "project",
	collectors: "project",
	"project-danger": "project",
	organization: "organization",
	"organization-authentication": "organization",
	"organization-members": "organization",
	"organization-delete": "organization",
	user: "user",
	appearance: "user",
} as const satisfies Record<string, SettingsScope>;
export type SettingsSection = keyof typeof settingsScopes;
export const settingsSections = Object.keys(
	settingsScopes,
) as SettingsSection[];
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
