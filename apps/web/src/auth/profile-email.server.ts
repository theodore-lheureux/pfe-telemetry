import { requestLocale } from "@recount/i18n";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	freshSessionMiddleware,
} from "better-auth/api";
import { and, eq, like, ne } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { session, verification } from "../db/schema";
import { accountContextHeader } from "./account-context";
import type { AuthEmail } from "./create-auth.server";
import type { AuthEmailDelivery } from "./email-delivery.server";

export function profileEmailSecurity(
	database: ReturnType<typeof getDatabase>,
	origin: string,
	email: AuthEmail,
	delivery: AuthEmailDelivery,
): BetterAuthPlugin {
	const matches = (ctx: { path?: string }) =>
		ctx.path === "/change-email" || ctx.path === "/verify-email";
	return {
		id: "recount-profile-email",
		hooks: {
			before: [
				{
					matcher: matches,
					handler: createAuthMiddleware(async (ctx) => {
						if (!email.sendProfileEmail)
							throw new APIError("SERVICE_UNAVAILABLE", {
								code: "EMAIL_CHANGE_UNAVAILABLE",
								message: "Email change is unavailable",
							});
						try {
							await freshSessionMiddleware(ctx);
						} finally {
							ctx.context.responseHeaders?.delete("set-cookie");
							ctx.responseHeaders.delete("set-cookie");
						}
						const current = ctx.context.session;
						if (!current?.user.emailVerified)
							throw new APIError("UNAUTHORIZED");
						if (ctx.headers?.get(accountContextHeader) !== current.user.id)
							throw new APIError("FORBIDDEN", {
								code: "ACCOUNT_CHANGED",
								message: "The active account changed",
							});
						if (
							ctx.path === "/change-email" &&
							typeof ctx.body?.newEmail === "string" &&
							ctx.body.newEmail.toLowerCase() === current.user.email
						)
							throw new APIError("BAD_REQUEST", {
								code: "EMAIL_UNCHANGED",
								message: "Enter a different email address",
							});
					}),
				},
			],
			after: [
				{
					matcher: matches,
					handler: createAuthMiddleware(async (ctx) => {
						// Neither a delayed success nor a rejected request may replace
						// cookies for an account selected in another tab.
						ctx.context.responseHeaders?.delete("set-cookie");
						ctx.responseHeaders.delete("set-cookie");
						const previous = ctx.context.session;
						const changed = ctx.context.newSession;
						if (
							ctx.path !== "/verify-email" ||
							!previous ||
							!changed ||
							changed.user.email === previous.user.email
						)
							return;
						await database
							.delete(session)
							.where(
								and(
									eq(session.userId, previous.user.id),
									ne(session.id, previous.session.id),
								),
							);
						// Better Auth stores pending second-factor challenges by user ID.
						await database
							.delete(verification)
							.where(
								and(
									eq(verification.value, previous.user.id),
									like(verification.identifier, "2fa-%"),
								),
							);
						const send = email.sendProfileEmail;
						if (send)
							delivery.track(
								delivery.send(() =>
									send({
										kind: "changed",
										email: previous.user.email,
										newEmail: changed.user.email,
										locale: requestLocale(ctx.headers),
										url: new URL("/settings?section=user", origin).href,
									}),
								),
							);
					}),
				},
			],
		},
	};
}
