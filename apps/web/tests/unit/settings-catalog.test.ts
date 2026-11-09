import { expect, test } from "bun:test";
import { UserRoundIcon } from "lucide-react";
import {
	getSettingsGroups,
	searchSettings,
} from "../../src/components/settings/settings-catalog";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../../src/organizations/contracts";

const organization: OrganizationSummary = {
	id: "org",
	name: "Private org value",
	slug: "private",
	role: "member",
};
const project: ProjectSummary = {
	id: "project",
	organizationId: "org",
	name: "Private project value",
	slug: "private",
	role: "viewer",
};

test("setting search includes individual controls and excludes unauthorized and private data", () => {
	const viewer = getSettingsGroups({ organization, project });
	expect(
		searchSettings(viewer, "email").flatMap((page) =>
			page.settings.map((setting) => setting.id),
		),
	).toContain("profile-email");
	expect(searchSettings(viewer, "clock")).toEqual([]);
	expect(searchSettings(viewer, "invitations")).toEqual([]);
	expect(searchSettings(viewer, "Private project value")).toEqual([]);
	expect(searchSettings(viewer, "billing")).toEqual([]);
	const admin = getSettingsGroups({
		organization: { ...organization, role: "admin" },
		project: { ...project, role: "admin" },
	});
	expect(
		searchSettings(admin, "  CLOCK  SKEW ").flatMap((page) =>
			page.settings.map((setting) => setting.id),
		),
	).toEqual(["credential-clock-skew"]);
	expect(getSettingsGroups({}).map((group) => group.scope)).toEqual(["user"]);
});

test("setting search normalizes French accents without indexing DOM or values", () => {
	const groups: ReturnType<typeof getSettingsGroups> = [
		{
			scope: "user",
			label: "Utilisateur",
			pages: [
				{
					section: "user",
					icon: UserRoundIcon,
					label: "Profil",
					settings: [
						{ id: "passkeys", label: "Clés d’accès", keywords: "Renommer" },
					],
				},
			],
		},
	];
	expect(searchSettings(groups, "CLES")[0]?.settings[0]?.id).toBe("passkeys");
	expect(searchSettings(groups, "utilisateur renommer")[0]?.section).toBe(
		"user",
	);
});
