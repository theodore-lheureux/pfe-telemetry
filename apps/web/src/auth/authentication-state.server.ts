import { getAuth } from "./auth.server";
import type { AuthenticationState } from "./authentication-state";
import { readAuthSession } from "./session.server";
import { AUTH_FRESH_AGE_SECONDS } from "./session-policy";

export async function readAuthenticationState(
	headers: Headers,
	auth = getAuth(),
): Promise<AuthenticationState> {
	const result = await readAuthSession(auth, headers, true);
	return {
		observedAt: new Date(),
		freshAgeSeconds: AUTH_FRESH_AGE_SECONDS,
		session: result
			? {
					id: result.session.id,
					createdAt: result.session.createdAt,
					expiresAt: result.session.expiresAt,
					user: {
						id: result.user.id,
						email: result.user.email,
						emailVerified: result.user.emailVerified,
					},
				}
			: null,
	};
}
