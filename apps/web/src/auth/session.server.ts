import { OperationError } from "../organizations/errors";
import type { createAuth } from "./create-auth.server";
import { requireVerifiedSession } from "./session-policy";

export async function applicationSession(
	auth: ReturnType<typeof createAuth>,
	headers: Headers,
) {
	return requireVerifiedSession(
		await auth.api.getSession({ headers }),
		({ code, message, reason }) => new OperationError(code, message, reason),
	);
}
