import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { deleteSessionCookie, expireCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins";
import { accountContextHeader } from "./account-context";

export function recountTwoFactor() {
	const plugin = twoFactor({
		issuer: "Recount",
		allowPasswordless: true,
		backupCodeOptions: { storeBackupCodes: "encrypted" },
		twoFactorCookieMaxAge: 300,
	});
	return {
		...plugin,
		endpoints: {
			...plugin.endpoints,
			twoFactorStatus: createAuthEndpoint(
				"/two-factor/status",
				{ method: "GET" },
				async (ctx) => {
					const cookie = ctx.context.createAuthCookie("two_factor");
					const identifier = await ctx.getSignedCookie(
						cookie.name,
						ctx.context.secret,
					);
					if (!identifier) return ctx.json({ pending: false });
					const record =
						await ctx.context.internalAdapter.findVerificationValue(identifier);
					if (!record || record.expiresAt <= new Date())
						return ctx.json({ pending: false });
					const user = await ctx.context.internalAdapter.findUserById(
						record.value,
					);
					return ctx.json({
						pending:
							!!user &&
							"twoFactorEnabled" in user &&
							user.twoFactorEnabled === true,
					});
				},
			),
		},
		hooks: {
			...plugin.hooks,
			before: [
				{
					matcher: (ctx: { path?: string }) =>
						[
							"/two-factor/enable",
							"/two-factor/disable",
							"/two-factor/get-totp-uri",
							"/two-factor/generate-backup-codes",
							"/two-factor/verify-totp",
							"/two-factor/verify-backup-code",
						].includes(ctx.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						if (ctx.body?.trustDevice === true)
							throw new APIError("FORBIDDEN", {
								code: "TRUST_DEVICE_DISABLED",
								message:
									"Email-code sign-in always requires a second factor when enabled",
							});
						const session = await getSessionFromCtx(ctx);
						if (
							session &&
							ctx.headers?.get(accountContextHeader) !== session.user.id
						)
							throw new APIError("FORBIDDEN", {
								code: "ACCOUNT_CHANGED",
								message:
									"The active account changed. Refresh before changing account security",
							});
					}),
				},
			],
			after: plugin.hooks.after.map((hook) => ({
				...hook,
				// Native challenge issuance is reused for email-code login. Verified passkeys remain direct.
				matcher: (context: Parameters<typeof hook.matcher>[0]) =>
					context.path === "/sign-in/email-otp" || hook.matcher(context),
				handler: createAuthMiddleware(async (ctx) => {
					const headers = new Headers(ctx.headers);
					if (ctx.path === "/sign-in/email-otp") {
						const trusted = ctx.context.createAuthCookie("trust_device");
						// Native middleware reparses its input headers, so omit remembered-device cookies before invoking it.
						headers.set(
							"cookie",
							(headers.get("cookie") ?? "")
								.split(";")
								.filter(
									(cookie) => cookie.trim().split("=", 1)[0] !== trusted.name,
								)
								.join(";"),
						);
						expireCookie(ctx, trusted);
					}
					const issued = ctx.context.newSession;
					try {
						const result: unknown = await hook.handler({
							...ctx,
							headers,
							returnHeaders: true,
							asResponse: false,
						});
						if (
							!result ||
							typeof result !== "object" ||
							!("headers" in result) ||
							!(result.headers instanceof Headers) ||
							!("response" in result)
						)
							throw new Error("Invalid authentication middleware response");
						for (const [name, value] of result.headers)
							if (name.toLowerCase() !== "set-cookie")
								ctx.responseHeaders.set(name, value);
						for (const cookie of result.headers.getSetCookie())
							ctx.responseHeaders.append("set-cookie", cookie);
						return result.response;
					} catch {
						// Never deliver a provisional session, including in earlier Set-Cookie headers, when challenge issuance fails.
						ctx.context.responseHeaders?.delete("set-cookie");
						ctx.responseHeaders.delete("set-cookie");
						deleteSessionCookie(ctx, true);
						expireCookie(ctx, ctx.context.createAuthCookie("two_factor"));
						ctx.context.setNewSession(null);
						if (issued)
							await ctx.context.internalAdapter
								.deleteSession(issued.session.token)
								.catch(() => {});
						throw new APIError("INTERNAL_SERVER_ERROR", {
							code: "TWO_FACTOR_UNAVAILABLE",
							message: "Two-factor sign-in is temporarily unavailable",
						});
					}
				}),
			})),
		},
	};
}
