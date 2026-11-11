import type { OperationResult } from "../lib/operation-result";
import { operationResult } from "../lib/operation-result.server";
import type { Actor } from "../organizations/access.server";
import type { createAuth } from "./create-auth.server";
import { applicationSession } from "./session.server";

export function readActor(
	auth: ReturnType<typeof createAuth>,
	headers: Headers,
) {
	return operationResult(
		async () => (await applicationSession(auth, headers)).user,
	);
}

export function withActor<T>(
	identity: OperationResult<Actor>,
	operation: (actor: Actor) => Promise<T>,
): Promise<OperationResult<T>> {
	return identity.error
		? Promise.resolve(identity)
		: operationResult(() => operation(identity.data));
}

// Non-HTTP callers authenticate independently; domain operations still authorize their own scope.
export function actorService(auth: ReturnType<typeof createAuth>) {
	return async <T>(headers: Headers, operation: (actor: Actor) => Promise<T>) =>
		withActor(await readActor(auth, headers), operation);
}
