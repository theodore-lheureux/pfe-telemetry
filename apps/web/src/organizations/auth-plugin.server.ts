import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { parseName, parseOrganizationInput, parseSlug } from "./validation";

function checkRole(role: unknown) {
	if (role !== "owner" && role !== "admin" && role !== "member") {
		throw new APIError("BAD_REQUEST", {
			message: "Select one organization role: owner, admin or member",
		});
	}
}

export function organizationPlugin() {
	return organization({
		allowUserToCreateOrganization: (user) => user.emailVerified,
		disableOrganizationDeletion: true,
		requireEmailVerificationOnInvitation: true,
		organizationHooks: {
			beforeCreateOrganization: async ({ organization }) => {
				try {
					return {
						data: { ...organization, ...parseOrganizationInput(organization) },
					};
				} catch (error) {
					throw new APIError("BAD_REQUEST", {
						message:
							error instanceof Error ? error.message : "Invalid organization",
					});
				}
			},
			beforeUpdateOrganization: async ({ organization }) => {
				try {
					return {
						data: {
							...organization,
							...(organization.name === undefined
								? {}
								: { name: parseName(organization.name) }),
							...(organization.slug === undefined
								? {}
								: { slug: parseSlug(organization.slug) }),
						},
					};
				} catch (error) {
					throw new APIError("BAD_REQUEST", {
						message:
							error instanceof Error ? error.message : "Invalid organization",
					});
				}
			},
			beforeAddMember: async ({ member }) => {
				checkRole(member.role);
			},
			beforeUpdateMemberRole: async ({ newRole }) => {
				checkRole(newRole);
			},
			beforeCreateInvitation: async ({ invitation }) => {
				checkRole(invitation.role ?? "member");
			},
			beforeAcceptInvitation: async ({ invitation }) => {
				checkRole(invitation.role ?? "member");
			},
		},
	});
}
