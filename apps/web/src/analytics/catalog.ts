import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import {
	getAnalyticsCatalog,
	getAttributeValues,
	getMetricAttributes,
} from "./analytics.functions";
import { commonAttributes, isCalculatedMetric } from "./calculated-metrics";
import type { AttributeDefinition } from "./contracts";

/** Where attribute value suggestions come from: a project and, optionally, one metric. */
export interface ValueSource {
	userId: string;
	reference: ProjectReference;
	metric?: string;
}

/** The project's discovered metrics and node names. */
export function useAnalyticsCatalog(
	userId: string,
	reference: ProjectReference,
	enabled: boolean,
) {
	return useQuery({ ...analyticsCatalogQuery(userId, reference), enabled });
}

export function analyticsCatalogQuery(
	userId: string,
	reference: ProjectReference,
) {
	return queryOptions({
		queryKey: ["analytics-catalog", userId, reference.projectId],
		queryFn: async ({ signal }) =>
			unwrapOperation(await getAnalyticsCatalog({ data: reference, signal })),
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
	return useQuery(metricAttributeOptions(userId, reference, metric, enabled));
}
function metricAttributeOptions(
	userId: string,
	reference: ProjectReference,
	metric: string | undefined,
	enabled: boolean,
) {
	return {
		queryKey: ["metric-attributes", userId, reference.projectId, metric],
		queryFn: async ({ signal }: { signal: AbortSignal }) =>
			unwrapOperation(
				await getMetricAttributes({
					data: metric === undefined ? reference : { ...reference, metric },
					signal,
				}),
			),
		enabled,
		staleTime: 60_000,
		retry: false,
	};
}

/** Calculated series expose only dimensions shared by every selected calculation. */
export function useQueryAttributes(
	userId: string,
	reference: ProjectReference,
	metrics: string[],
	enabled: boolean,
) {
	const calculated = [...new Set(metrics.filter(isCalculatedMetric))];
	const names: (string | undefined)[] = calculated.length
		? calculated
		: [undefined];
	const queries = useQueries({
		queries: names.map((metric) =>
			metricAttributeOptions(userId, reference, metric, enabled),
		),
	});
	const catalogs = queries.map((query) => query.data);
	return {
		data: catalogs.every((catalog) => catalog !== undefined)
			? commonAttributes(catalogs as AttributeDefinition[][])
			: undefined,
		isFetching: queries.some((query) => query.isFetching),
	};
}

/** Recent values of an attribute field, most frequent first, once a field is chosen. */
export function useAttributeValues(source: ValueSource, field: string | null) {
	const { userId, reference, metric } = source;
	return useQuery({
		queryKey: [
			"attribute-values",
			userId,
			reference.projectId,
			metric ?? null,
			field,
		],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await getAttributeValues({
					data: {
						...reference,
						field: field as string,
						...(metric === undefined ? {} : { metric }),
					},
					signal,
				}),
			),
		enabled: field !== null,
		staleTime: 60_000,
		retry: false,
	});
}
