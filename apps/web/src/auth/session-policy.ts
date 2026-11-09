export const AUTH_FRESH_AGE_SECONDS = 600;

export type SessionFailure =
	| { code: "UNAUTHENTICATED"; message: string; reason?: never }
	| {
			code: "FORBIDDEN";
			message: string;
			reason: "VERIFIED_EMAIL_REQUIRED";
	  };

export function requireVerifiedSession<
	T extends { user: { emailVerified: boolean } },
>(session: T | null, error: (failure: SessionFailure) => Error): T {
	if (!session)
		throw error({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
	if (!session.user.emailVerified)
		throw error({
			code: "FORBIDDEN",
			message: "Verify your email to continue",
			reason: "VERIFIED_EMAIL_REQUIRED",
		});
	return session;
}
