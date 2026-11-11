import { useQuery } from "@tanstack/react-query";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import {
	getAnalyticsCatalog,
	getMetricAttributes,
} from "./analytics.functions";

/** The project's discovered metrics and node names. */
export function useAnalyticsCatalog(
	userId: string,
	reference: ProjectReference,
	enabled: boolean,
) {
	return useQuery({
		queryKey: ["analytics-catalog", userId, reference.projectId],
		queryFn: async ({ signal }) =>
			unwrapOperation(await getAnalyticsCatalog({ data: reference, signal })),
		enabled,
		staleTime: 60_000,
		retry: false,
	});
}

/** Discovered attributes of one metric, or of every metric when none is given. */
export function useMetricAttributes(
	userId: string,
	reference: ProjectReference,
	metric: string | undefined,
	enabled: boolean,
) {
	return useQuery({
		queryKey: ["metric-attributes", userId, reference.projectId, metric],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await getMetricAttributes({
					data: metric === undefined ? reference : { ...reference, metric },
					signal,
				}),
			),
		enabled,
		staleTime: 60_000,
		retry: false,
	});
}
