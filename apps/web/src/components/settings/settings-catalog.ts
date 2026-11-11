import { m } from "@recount/i18n/messages";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../../organizations/contracts";
import {
	type SettingsScope,
	type SettingsSection,
	settingsScopes,
	settingsSections,
} from "../settings-links";
import {
	authenticationFeatures,
	twoFactorFeature,
} from "./authentication-features";

type Permission = "project-admin" | "organization-admin";
interface Setting {
	id: string;
	label: () => string;
	keywords?: (() => string)[];
	permission?: Permission;
}
interface Page {
	label: () => string;
	permission?: Permission;
	settings: Setting[];
}

export const settingsCatalog = {
	project: {
		label: m.settings_general,
		settings: [
			{ id: "project-identifier", label: m.project_identifier },
			{
				id: "collector-setup",
				label: m.collector_credentials,
				permission: "project-admin",
			},
		],
	},
	"project-customization": {
		label: m.settings_customization,
		settings: [
			{ id: "project-details", label: m.settings_project_details },
			{ id: "entity-name", label: m.name, permission: "project-admin" },
			{
				id: "project-tags",
				label: m.project_tags,
				keywords: [m.project_add_tag],
			},
			{ id: "project-group", label: m.project_group },
			{
				id: "project-time-zone",
				label: m.project_time_zone,
				keywords: [m.project_date_time],
			},
			{ id: "project-week-start", label: m.project_week_start },
		],
	},
	"project-danger": {
		label: m.settings_danger_zone,
		permission: "project-admin",
		settings: [
			{ id: "move-project", label: m.settings_move_project },
			{ id: "delete-project", label: m.settings_delete_project },
		],
	},
	"project-members": {
		label: m.project_access_control,
		permission: "project-admin",
		settings: [
			{
				id: "grants-heading",
				label: m.project_access,
				keywords: [m.project_members],
			},
			{ id: "project-default-access", label: m.project_default_access },
			{ id: "project-inherited-roles", label: m.project_roles },
		],
	},
	collectors: {
		label: m.collectors,
		permission: "project-admin",
		settings: [
			{
				id: "enrollment-keys",
				label: m.enrollment_keys,
				keywords: [m.enrollment_key_create],
			},
			{ id: "collector-nodes", label: m.nodes },
		],
	},
	organization: {
		label: m.settings_general,
		settings: [
			{ id: "organization-name", label: m.name },
			{ id: "organization-identifier", label: m.organization_id },
		],
	},
	"organization-authentication": {
		label: m.settings_authentication,
		settings: [
			{ id: "available-authentication", label: m.settings_current_auth },
			...authenticationFeatures,
		],
	},
	"organization-delete": {
		label: m.settings_delete_organization,
		settings: [
			{ id: "delete-organization", label: m.settings_delete_organization },
		],
	},
	"organization-members": {
		label: m.members,
		settings: [
			{ id: "members-heading", label: m.organization_members },
			{
				id: "invitations-heading",
				label: m.settings_pending_invites,
				permission: "organization-admin",
			},
			twoFactorFeature,
		],
	},
	user: {
		label: m.user_profile,
		settings: [
			{
				id: "profile-picture",
				label: m.profile_picture,
				keywords: [m.change_on_gravatar, m.check_again],
			},
			{ id: "entity-name", label: m.name, keywords: [m.save_name] },
			{ id: "profile-email", label: m.email_address },
			{
				id: "two-factor-authentication",
				label: m.settings_two_factor,
				keywords: [
					m.two_factor_setup,
					m.two_factor_disable,
					m.two_factor_regenerate,
				],
			},
			{
				id: "passkeys",
				label: m.passkeys,
				keywords: [m.add_a_passkey, m.rename_passkey, m.remove],
			},
			{ id: "passkey-name", label: m.passkey_name },
			{
				id: "login-sessions",
				label: m.web_sessions,
				keywords: [
					m.device,
					m.last_active,
					m.sign_out_other_sessions,
					m.revoke_device,
				],
			},
		],
	},
	appearance: {
		label: m.appearance_language,
		settings: [
			{
				id: "theme",
				label: m.theme,
				keywords: [m.theme_light, m.theme_dark, m.theme_system],
			},
			{ id: "language", label: m.language },
		],
	},
} satisfies Record<SettingsSection, Page>;

export function getSettingsGroups(context: {
	organization?: OrganizationSummary;
	project?: ProjectSummary;
}) {
	const permitted = (permission?: Permission) =>
		!permission ||
		(permission === "project-admin"
			? context.project?.role === "admin"
			: !!context.organization && context.organization.role !== "member");
	const scopes: { scope: SettingsScope; label: string }[] = [
		{ scope: "project", label: m.project() },
		{ scope: "organization", label: m.organization() },
		{ scope: "user", label: m.user_settings_group() },
	];
	return scopes
		.map((group) => ({
			...group,
			pages: settingsSections.flatMap((section) => {
				const page: Page = settingsCatalog[section];
				const scope = settingsScopes[section];
				if (
					scope !== group.scope ||
					!permitted(page.permission) ||
					(scope !== "user" && !context[scope])
				)
					return [];
				return [
					{
						section,
						label: page.label(),
						settings: page.settings
							.filter((setting) => permitted(setting.permission))
							.map((setting) => ({
								id: setting.id,
								label: setting.label(),
								keywords:
									setting.keywords?.map((label) => label()).join(" ") ?? "",
							})),
					},
				];
			}),
		}))
		.filter((group) => group.pages.length);
}

export function searchSettings(
	groups: ReturnType<typeof getSettingsGroups>,
	query: string,
) {
	const normalize = (text: string) =>
		text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
	const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
	return groups
		.flatMap((group) =>
			group.pages.map((page) => ({
				...page,
				group: `${page.label} (${group.label})`,
				settings: page.settings.filter((setting) => {
					const text = normalize(
						`${group.label} ${page.label} ${setting.label} ${setting.keywords}`,
					);
					return terms.every((term) => text.includes(term));
				}),
			})),
		)
		.filter((page) => page.settings.length);
}
