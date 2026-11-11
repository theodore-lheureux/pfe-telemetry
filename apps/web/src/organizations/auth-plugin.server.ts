import { randomUUID } from "node:crypto";
import { requestLocale } from "@recount/i18n";
import type { OrganizationInvitationEmailProps } from "@recount/transactional";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { organization } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import { requireVerifiedSession } from "../auth/session-policy";
import type { getDatabase } from "../db/client.server";
import { invitation, member, rateLimit } from "../db/schema";
import { parseName } from "../lib/input";
import { resolveOrganizationRole } from "./access.server";
import { parseInvitationPersonalization } from "./invitation-validation";
import { isOrganizationGrantRole } from "./roles";
import { parseOrganizationInput, parseSlug } from "./validation";

function checkRole(role: unknown) {
	if (!isOrganizationGrantRole(role)) {
		throw new APIError("BAD_REQUEST", {
			message: "Select one organization role: owner, admin or member",
		});
	}
}

export function invitationSecurity(database: ReturnType<typeof getDatabase>) {
	return {
		id: "invitation-security",
		hooks: {
			before: [
				{
					matcher: (ctx) =>
						[
							"/organization/invite-member",
							"/organization/list-invitations",
							"/organization/get-full-organization",
							"/organization/cancel-invitation",
						].includes(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						const session = requireVerifiedSession(
							await getSessionFromCtx(ctx),
							({ code, message, reason }) =>
								new APIError(
									code === "UNAUTHENTICATED" ? "UNAUTHORIZED" : "FORBIDDEN",
									{ message, ...(reason ? { code: reason } : {}) },
								),
						);
						if (ctx.path !== "/organization/invite-member") return;
						checkRole(ctx.body?.role);
						try {
							parseInvitationPersonalization(ctx.body ?? {});
						} catch {
							throw new APIError("BAD_REQUEST", {
								message: "Invalid invitation name or message",
							});
						}
						// Share the send limit with server API calls, within native cleanup's 60-second window.
						const now = Date.now();
						const key = `invitation-send:${session.user.id}`;
						const [limit] = await database
							.insert(rateLimit)
							.values({
								id: randomUUID(),
								key,
								count: 1,
								lastRequest: now,
							})
							.onConflictDoUpdate({
								target: rateLimit.key,
								set: {
									count: sql`CASE WHEN ${rateLimit.lastRequest} <= ${now - 60_000} THEN 1 ELSE ${rateLimit.count} + 1 END`,
									lastRequest: sql`CASE WHEN ${rateLimit.lastRequest} <= ${now - 60_000} THEN ${now} ELSE ${rateLimit.lastRequest} END`,
								},
							})
							.returning({ count: rateLimit.count });
						if (limit.count > 10)
							throw new APIError("TOO_MANY_REQUESTS", {
								message: "Too many invitation attempts; try again in a minute",
							});
						if (!ctx.body?.resend) return;
						const organizationId =
							ctx.body.organizationId || session.session.activeOrganizationId;
						if (!organizationId || typeof ctx.body.email !== "string") return;
						const [membership] = await database
							.select({ role: member.role })
							.from(member)
							.where(
								and(
									eq(member.organizationId, organizationId),
									eq(member.userId, session.user.id),
								),
							);
						const role = membership && resolveOrganizationRole(membership.role);
						if (role !== "owner" && role !== "admin") return;
						// Native resend skips beforeCreateInvitation; check the stored role here.
						const pending = await database
							.select({ role: invitation.role })
							.from(invitation)
							.where(
								and(
									eq(invitation.organizationId, organizationId),
									eq(invitation.email, ctx.body.email.toLowerCase()),
									eq(invitation.status, "pending"),
									gt(invitation.expiresAt, new Date()),
								),
							);
						if (pending.some((entry) => entry.role !== ctx.body.role))
							throw new APIError("BAD_REQUEST", {
								message:
									"Resend must keep the invitation role; cancel it before changing the role",
							});
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}

export function organizationPlugin(
	origin: string,
	sendInvitation: (props: OrganizationInvitationEmailProps) => Promise<void>,
) {
	return organization({
		invitationExpiresIn: 3 * 24 * 60 * 60,
		schema: {
			invitation: {
				additionalFields: {
					recipientName: { type: "string", required: false },
					message: { type: "string", required: false },
				},
			},
		},
		allowUserToCreateOrganization: (user) => user.emailVerified,
		disableOrganizationDeletion: true,
		requireEmailVerificationOnInvitation: true,
		sendInvitationEmail: async (
			{ id, email, role, organization, inviter, invitation },
			request,
		) => {
			checkRole(role);
			await sendInvitation({
				locale: requestLocale(request?.headers),
				url: new URL(`/invitations/${encodeURIComponent(id)}`, origin).href,
				email,
				role: role as OrganizationInvitationEmailProps["role"],
				organizationName: organization.name,
				inviterEmail: inviter.user.email,
				inviterName: inviter.user.name || undefined,
				expiresAt: invitation.expiresAt,
				...parseInvitationPersonalization(invitation),
			});
		},
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
			beforeRejectInvitation: async ({ invitation }) => {
				if (invitation.expiresAt <= new Date())
					throw new APIError("BAD_REQUEST", {
						code: "INVITATION_NOT_FOUND",
						message: "Invitation is unavailable",
					});
			},
			beforeCancelInvitation: async ({ invitation }) => {
				if (invitation.status !== "pending")
					throw new APIError("CONFLICT", {
						message: "Invitation is no longer pending",
					});
			},
		},
	});
}
