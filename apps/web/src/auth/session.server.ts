import { OperationError } from "../lib/operation-error";
import type { createAuth } from "./create-auth.server";
import { requireVerifiedSession } from "./session-policy";

export function readAuthSession(
	auth: ReturnType<typeof createAuth>,
	headers: Headers,
	disableRefresh = false,
) {
	return auth.api.getSession({
		headers,
		query: { disableCookieCache: true, disableRefresh },
	});
}

export async function applicationSession(
	auth: ReturnType<typeof createAuth>,
	headers: Headers,
) {
	return requireVerifiedSession(
		await readAuthSession(auth, headers),
		({ code, message, reason }) => new OperationError(code, message, reason),
	);
}
