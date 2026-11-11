import type { SettingsSection } from "../src/components/settings-links";

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
