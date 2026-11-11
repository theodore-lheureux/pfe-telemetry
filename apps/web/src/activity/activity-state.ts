import { MutationFailure } from "../lib/operation-result";
import type { LiveSnapshot, PointPage } from "./contracts";

export function activityAccessDenied(error: unknown) {
	return (
		error instanceof MutationFailure &&
		["UNAUTHENTICATED", "SESSION_NOT_FRESH", "FORBIDDEN", "NOT_FOUND"].includes(
			error.failure.code,
		)
	);
}
export function displayedActivity({
	paused,
	frozen,
	data,
	error,
}: {
	paused: boolean;
	frozen: PointPage | LiveSnapshot | null;
	data?: PointPage | LiveSnapshot;
	error: unknown;
}) {
	if (activityAccessDenied(error)) return undefined;
	if (paused) return frozen ?? undefined;
	return error ? undefined : data;
}
