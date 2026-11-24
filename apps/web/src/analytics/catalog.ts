import { getLocale } from "@recount/i18n/runtime";
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { resolveRange } from "../components/date-range/date-range";
import { useDisplayTimeZone } from "../components/time-display";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import {
	getAnalyticsCatalog,
	getAttributeValues,
	getMetricAttributes,
	runAnalyticsQuery,
} from "./analytics.functions";
import { commonAttributes } from "./calculated-metrics";
import type {
	AnalyticsQuery,
	AttributeDefinition,
	Filter,
	MetricCoverage,
} from "./contracts";
import { coverageMeasures } from "./coverage";

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
/**
 * Whose attributes a query can filter or break down by: those every chosen metric
 * carries, or the project's when none is chosen yet.
 */
export function attributeSources(metrics: string[]): (string | undefined)[] {
	const chosen = [...new Set(metrics)];
	return chosen.length ? chosen : [undefined];
}

export function useQueryAttributes(
	userId: string,
	reference: ProjectReference,
	metrics: string[],
	enabled: boolean,
) {
	const queries = useQueries({
		queries: attributeSources(metrics).map((metric) =>
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

/** Coverage gauges report per-node populations, not individual subjects. */
export function useMetricCoverage(
	userId: string,
	reference: ProjectReference,
	scope: { range: Parameters<typeof resolveRange>[0]; filters: Filter[] },
	coverage: MetricCoverage | undefined,
) {
	const zone = useDisplayTimeZone();
	const locale = getLocale();
	const measures = coverageMeasures(coverage);
	// Coverage is per node, so only node filters apply to it.
	const filters = scope.filters.filter(
		({ field }) => field === "node" || field === "host",
	);
	return useQuery({
		queryKey: [
			"metric-coverage",
			userId,
			reference.projectId,
			measures,
			filters,
			scope.range,
			zone,
			locale,
		],
		queryFn: async ({ signal }) => {
			const now = new Date();
			const { from, to } = resolveRange(scope.range, now, zone, locale);
			const query: AnalyticsQuery = {
				shape: "table",
				range: { from: from.toISOString(), to: (to ?? now).toISOString() },
				measures,
				filters,
			};
			const result = unwrapOperation(
				await runAnalyticsQuery({ data: { ...reference, query }, signal }),
			);
			const value = (name: string) =>
				result.series.find((series) => series.measure === name)?.points[0]
					?.value ?? null;
			return {
				shown: value("shown"),
				total: value("total"),
				nodes: value("nodes"),
				omitted: value("omitted"),
				unit: result.measures[0]?.unit ?? "",
			};
		},
		enabled: measures.length > 0,
		staleTime: 60_000,
		retry: false,
	});
}
