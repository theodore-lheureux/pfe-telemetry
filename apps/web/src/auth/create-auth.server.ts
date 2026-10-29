import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { type Locale, requestLocale } from "@pfe/i18n";
import type { OrganizationInvitationEmailProps } from "@pfe/transactional";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { createAuthMiddleware, freshSessionMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { getDatabase } from "../db/client.server";
import * as schema from "../db/schema";
import {
	invitationSecurity,
	organizationPlugin,
} from "../organizations/auth-plugin.server";
import type { AuthConfig } from "./config.server";

const credentialSecurity = {
	id: "credential-security",
	hooks: {
		before: [
			{
				matcher: (ctx) =>
					ctx.path === "/passkey/delete-passkey" ||
					ctx.path === "/passkey/update-passkey",
				handler: createAuthMiddleware(async (ctx) => {
					await freshSessionMiddleware(ctx);
				}),
			},
		],
	},
} satisfies BetterAuthPlugin;

export function createAuth(
	config: AuthConfig,
	database: ReturnType<typeof getDatabase>,
	email: {
		sendSignInLink: (
			email: string,
			url: string,
			locale: Locale,
		) => Promise<void>;
		sendOrganizationInvitation: (
			props: OrganizationInvitationEmailProps,
		) => Promise<void>;
	},
) {
	return betterAuth({
		appName: "PFE Telemetry",
		baseURL: config.origin,
		secret: config.secret,
		trustedOrigins: [config.origin],
		database: drizzleAdapter(database, {
			provider: "pg",
			schema,
			schemaName: "app",
			transaction: true,
		}),
		emailAndPassword: { enabled: false },
		session: { freshAge: 600, cookieCache: { enabled: false } },
		rateLimit: { enabled: true, storage: "database" },
		advanced: {
			useSecureCookies: config.origin.startsWith("https:"),
			disableOriginCheck: false,
			disableCSRFCheck: false,
		},
		plugins: [
			organizationPlugin(config.origin, email.sendOrganizationInvitation),
			invitationSecurity(database),
			magicLink({
				disableSignUp: !config.allowSignUp,
				storeToken: "hashed",
				expiresIn: 300,
				sendMagicLink: ({ email: recipient, url }, context) =>
					email.sendSignInLink(recipient, url, requestLocale(context?.headers)),
			}),
			passkey({
				rpID: config.rpID,
				rpName: "PFE Telemetry",
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
}
