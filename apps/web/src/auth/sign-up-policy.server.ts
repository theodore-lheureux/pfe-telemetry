import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, gt, sql } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { invitation, user } from "../db/schema";
import { SIGN_UP_DISABLED } from "./sign-up-policy";

type Database = ReturnType<typeof getDatabase>;

const signUpDisabled = () =>
	new APIError("FORBIDDEN", {
		code: SIGN_UP_DISABLED,
		message: "Sign-up is closed",
	});

async function hasPendingInvitation(database: Database, email: string) {
	const [row] = await database
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				sql`lower(${invitation.email}) = lower(${email})`,
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, new Date()),
			),
		)
		.limit(1);
	return Boolean(row);
}

async function hasAccount(database: Database, email: string) {
	const [row] = await database
		.select({ id: user.id })
		.from(user)
		.where(sql`lower(${user.email}) = lower(${email})`)
		.limit(1);
	return Boolean(row);
}

/** New accounts need open sign-up or a pending, unexpired invitation. */
export async function assertAccountCreationAllowed(
	database: Database,
	allowSignUp: boolean,
	email: string,
) {
	if (allowSignUp || (await hasPendingInvitation(database, email))) return;
	throw signUpDisabled();
}

/**
 * Reports closed sign-up before a code is sent, instead of silently sending
 * nothing. This reveals whether an uninvited address has an account, which the
 * owner accepted in exchange for a clear error.
 */
export function signUpPolicy(
	database: Database,
	allowSignUp: boolean,
): BetterAuthPlugin {
	return {
		id: "sign-up-policy",
		hooks: {
			before: [
				{
					matcher: (ctx) =>
						!allowSignUp &&
						ctx.path === "/email-otp/send-verification-otp" &&
						ctx.body?.type === "sign-in",
					handler: createAuthMiddleware(async (ctx) => {
						const email = String(ctx.body?.email ?? "");
						if (!email || (await hasAccount(database, email))) return;
						await assertAccountCreationAllowed(database, allowSignUp, email);
					}),
				},
			],
		},
	};
}
