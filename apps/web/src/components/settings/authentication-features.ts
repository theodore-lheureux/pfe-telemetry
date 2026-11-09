import { m } from "@recount/i18n/messages";

export const authenticationFeatures = [
	{
		id: "authentication-domains",
		label: m.settings_auth_domains,
		description: m.settings_auth_domains_description,
		ticket: "PFE-66",
		url: "https://linear.app/pfe-telemetry/issue/PFE-66/add-verified-authentication-domains-and-automatic-organization",
	},
	{
		id: "domain-enforcement",
		label: m.settings_domain_enforcement,
		description: m.settings_domain_enforcement_description,
		ticket: "PFE-71",
		url: "https://linear.app/pfe-telemetry/issue/PFE-71/add-organization-domain-enforcement-and-sso-recovery-policy",
	},
	{
		id: "saml-configuration",
		label: m.settings_saml,
		description: m.settings_saml_description,
		ticket: "PFE-65",
		url: "https://linear.app/pfe-telemetry/issue/PFE-65/add-organization-saml-single-sign-on",
	},
	{
		id: "oidc-configuration",
		label: m.settings_oidc,
		description: m.settings_oidc_description,
		ticket: "PFE-67",
		url: "https://linear.app/pfe-telemetry/issue/PFE-67/add-organization-oidc-single-sign-on",
	},
	{
		id: "scim-configuration",
		label: m.settings_scim,
		description: m.settings_scim_description,
		ticket: "PFE-70",
		url: "https://linear.app/pfe-telemetry/issue/PFE-70/add-scim-organization-member-provisioning",
	},
	{
		id: "xaa-configuration",
		label: m.settings_xaa,
		description: m.settings_xaa_description,
		ticket: "PFE-69",
		url: "https://linear.app/pfe-telemetry/issue/PFE-69/evaluate-and-add-xaa-delegated-authentication",
	},
] as const;

export const twoFactorFeature = {
	id: "two-factor-authentication",
	label: m.settings_two_factor,
	description: m.settings_two_factor_description,
	ticket: "PFE-68",
	url: "https://linear.app/pfe-telemetry/issue/PFE-68/add-two-factor-authentication-and-organization-enforcement",
};
