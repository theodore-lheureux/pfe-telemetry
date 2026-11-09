import { type AnyRouter, isNotFound } from "@tanstack/react-router";

export function mutationRefreshFailed(router: AnyRouter) {
	return router.state.matches.some(
		(match) =>
			match.status === "error" ||
			match.status === "notFound" ||
			isNotFound(match.error),
	);
}
