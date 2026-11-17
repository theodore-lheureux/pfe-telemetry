import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import type { QueryResult } from "../analytics/contracts";
import { unwrapOperation } from "../lib/operation-result";
import type { ExecutionReference } from "./contracts";
import { getExecutionMeasurements } from "./execution.functions";

export function executionMeasurementsKey(
	userId: string,
	reference: ExecutionReference,
) {
	return [
		"execution-measurements",
		userId,
		reference.projectId,
		reference.executionKey,
	] as const;
}

/**
 * The execution's process measurements, optionally for one node. They load after the
 * page, and refresh only when the page is refreshed.
 */
export function useExecutionMeasurements(
	userId: string,
	reference: ExecutionReference,
	node: string | undefined,
) {
	return useQuery<QueryResult | null>({
		queryKey: [...executionMeasurementsKey(userId, reference), node ?? null],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await getExecutionMeasurements({
					data: {
						organizationId: reference.organizationId,
						projectId: reference.projectId,
						executionKey: reference.executionKey,
						...(node ? { node } : {}),
					},
					signal,
				}),
			),
		enabled: useHydrated(),
		// A refresh keeps the shown charts; another machine never shows the previous one's.
		placeholderData: (previous, query) =>
			query?.queryKey.at(-1) === (node ?? null)
				? keepPreviousData(previous)
				: undefined,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
}
