import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { type Locale, requestLocale } from "@recount/i18n";
import type { OrganizationInvitationEmailProps } from "@recount/transactional";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	freshSessionMiddleware,
} from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { getDatabase } from "../db/client.server";
import * as schema from "../db/schema";
import {
	invitationSecurity,
	organizationPlugin,
} from "../organizations/auth-plugin.server";
import type { AuthConfig } from "./config.server";
import {
	type AuthEmailDelivery,
	createAuthEmailDelivery,
} from "./email-delivery.server";
import { AUTH_FRESH_AGE_SECONDS } from "./session-policy";

const credentialSecurity = {
	id: "credential-security",
	hooks: {
		before: [
			{
				matcher: (ctx) =>
					ctx.path === "/email-otp/send-verification-otp" &&
					ctx.body?.type !== "sign-in",
				handler: createAuthMiddleware(async () => {
					throw new APIError("BAD_REQUEST", {
						message: "Unsupported email code purpose",
					});
				}),
			},
			{
				matcher: (ctx) =>
					ctx.path === "/passkey/delete-passkey" ||
					ctx.path === "/passkey/update-passkey",
				handler: createAuthMiddleware(async (ctx) => {
					await freshSessionMiddleware(ctx);
				}),
			},
		],
		after: [
			{
				matcher: (ctx) => ctx.path === "/sign-in/email-otp",
				handler: createAuthMiddleware(async (ctx) => {
					const result = ctx.context.returned;
					if (
						ctx.request &&
						result instanceof APIError &&
						[
							"INVALID_OTP",
							"OTP_EXPIRED",
							"OTP_NOT_FOUND",
							"TOO_MANY_ATTEMPTS",
							"USER_NOT_FOUND",
						].includes(String(result.body?.code))
					) {
						return Response.json(
							{ code: "INVALID_OTP", message: "Invalid or expired code" },
							{ status: 400 },
						);
					}
				}),
			},
		],
	},
} satisfies BetterAuthPlugin;

export function createAuth(
	config: AuthConfig,
	database: ReturnType<typeof getDatabase>,
	email: {
		sendSignInCode: (
			email: string,
			code: string,
			locale: Locale,
		) => Promise<void>;
		sendOrganizationInvitation: (
			props: OrganizationInvitationEmailProps,
		) => Promise<void>;
	},
	emailDelivery: AuthEmailDelivery = createAuthEmailDelivery(),
) {
	const auth = betterAuth({
		appName: "Recount",
		baseURL: config.origin,
		secret: config.secret,
		trustedOrigins: [config.origin],
		disabledPaths: [
			"/email-otp/check-verification-otp",
			"/email-otp/verify-email",
			"/email-otp/request-password-reset",
			"/forget-password/email-otp",
			"/email-otp/reset-password",
			"/email-otp/request-email-change",
			"/email-otp/change-email",
		],
		database: drizzleAdapter(database, {
			provider: "pg",
			schema,
			schemaName: "app",
			transaction: true,
		}),
		emailAndPassword: { enabled: false },
		session: {
			freshAge: AUTH_FRESH_AGE_SECONDS,
			cookieCache: { enabled: false },
		},
		rateLimit: { enabled: true, storage: "database" },
		advanced: {
			backgroundTasks: { handler: emailDelivery.track },
			useSecureCookies: config.origin.startsWith("https:"),
			disableOriginCheck: false,
			disableCSRFCheck: false,
		},
		plugins: [
			organizationPlugin(config.origin, email.sendOrganizationInvitation),
			invitationSecurity(database),
			emailOTP({
				otpLength: 6,
				expiresIn: 300,
				allowedAttempts: 3,
				storeOTP: "hashed",
				disableSignUp: !config.allowSignUp,
				rateLimit: { window: 60, max: 3 },
				sendVerificationOTP: ({ email: recipient, otp, type }, context) => {
					if (type !== "sign-in")
						throw new Error("Unsupported email code purpose");
					const locale = requestLocale(context?.headers);
					return emailDelivery.send(() =>
						email.sendSignInCode(recipient, otp, locale),
					);
				},
			}),
			passkey({
				rpID: config.rpID,
				rpName: "Recount",
				origin: config.origin,
				authenticatorSelection: {
					residentKey: "required",
					userVerification: "required",
				},
			}),
			credentialSecurity,
			tanstackStartCookies(),
		],
	});
	return Object.assign(auth, {
		emailDelivery,
	});
}
