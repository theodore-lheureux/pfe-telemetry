import { m } from "@recount/i18n/messages";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../../organizations/contracts";
import { type SettingsSection, settingsSections } from "../settings-links";

type Scope = "project" | "organization" | "user";
type Permission = "project-admin" | "organization-admin";
interface Setting {
	id: string;
	label: () => string;
	keywords?: (() => string)[];
	permission?: Permission;
}
interface Page {
	scope: Scope;
	label: () => string;
	permission?: Permission;
	settings: Setting[];
}

const catalog = {
	project: {
		scope: "project",
		label: m.project_settings,
		settings: [
			{ id: "entity-name", label: m.name, permission: "project-admin" },
			{ id: "project-slug", label: m.slug },
			{ id: "project-identifier", label: m.project_identifier },
		],
	},
	"project-members": {
		scope: "project",
		label: m.project_members,
		permission: "project-admin",
		settings: [
			{
				id: "grants-heading",
				label: m.project_access,
				keywords: [m.project_members],
			},
		],
	},
	credentials: {
		scope: "project",
		label: m.collector_credentials,
		permission: "project-admin",
		settings: [
			{
				id: "credential-list-title",
				label: m.enrolled_sources,
				keywords: [m.collector_credentials],
			},
			{ id: "create-credential-title", label: m.create_collector_credential },
			{ id: "credential-name", label: m.credential_name },
			{ id: "credential-source", label: m.source_id },
			{ id: "credential-root", label: m.enrolled_root_id },
			{ id: "credential-expiry", label: m.expires_at_your_local_time_optional },
			{ id: "credential-maximum-age", label: m.maximum_submission_age_seconds },
			{ id: "credential-clock-skew", label: m.allowed_clock_skew_seconds },
		],
	},
	organization: {
		scope: "organization",
		label: m.organization_settings,
		settings: [
			{ id: "organization-name", label: m.name },
			{ id: "organization-slug", label: m.slug },
			{ id: "organization-role", label: m.your_role },
			{ id: "organization-identifier", label: m.organization_id },
		],
	},
	"organization-members": {
		scope: "organization",
		label: m.members,
		settings: [
			{ id: "members-heading", label: m.organization_members },
			{
				id: "invitations-heading",
				label: m.invitations,
				permission: "organization-admin",
			},
		],
	},
	user: {
		scope: "user",
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
		scope: "user",
		label: m.appearance_language,
		settings: [
			{
				id: "appearance",
				label: m.appearance,
				keywords: [m.theme_switch_light, m.theme_switch_dark],
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
	const scopes: { scope: Scope; label: string }[] = [
		{ scope: "project", label: m.project() },
		{ scope: "organization", label: m.organization() },
		{ scope: "user", label: m.user_settings_group() },
	];
	return scopes
		.map((group) => ({
			...group,
			pages: settingsSections.flatMap((section) => {
				const page: Page = catalog[section];
				if (
					page.scope !== group.scope ||
					!permitted(page.permission) ||
					(page.scope !== "user" && !context[page.scope])
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
