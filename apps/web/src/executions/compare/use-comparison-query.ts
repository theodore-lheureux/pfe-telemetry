import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { runAnalyticsQuery } from "../../analytics/analytics.functions";
import type { AnalyticsQuery, QueryResult } from "../../analytics/contracts";
import { unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";

/** Runs the aligned comparison query once the page is interactive. */
export function useComparisonQuery(
	userId: string,
	reference: ProjectReference,
	query: AnalyticsQuery | null,
) {
	const hydrated = useHydrated();
	return useQuery<QueryResult>({
		queryKey: ["analytics-query", userId, reference.projectId, query],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await runAnalyticsQuery({
					data: { ...reference, query: query as AnalyticsQuery },
					signal,
				}),
			),
		enabled: hydrated && query !== null,
		retry: false,
		staleTime: 60_000,
		refetchOnWindowFocus: false,
	});
}
