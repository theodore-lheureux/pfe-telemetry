import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { unwrapOperation } from "../lib/operation-result";
import type { ExecutionReference } from "./contracts";
import { getExecutionLoad, getExecutionOverlaps } from "./overlap.functions";

/** Overlapping executions and the load split, read independently after hydration. */
export function useExecutionOverlaps(
	userId: string,
	reference: ExecutionReference,
) {
	const enabled = useHydrated();
	const { organizationId, projectId, executionKey } = reference;
	const data = { organizationId, projectId, executionKey };
	const key = [userId, organizationId, projectId, executionKey];
	const options = { enabled, retry: false, staleTime: 60_000 } as const;
	const overlaps = useQuery({
		...options,
		queryKey: ["execution-overlaps", ...key],
		queryFn: async ({ signal }) =>
			unwrapOperation(await getExecutionOverlaps({ data, signal })),
	});
	const load = useQuery({
		...options,
		queryKey: ["execution-load", ...key],
		queryFn: async ({ signal }) =>
			unwrapOperation(await getExecutionLoad({ data, signal })),
	});
	return { overlaps, load };
}
