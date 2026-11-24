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
import type { AnalyticsQuery, AttributeDefinition, Filter } from "./contracts";

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

const COVERAGE = "recount.collection.process.coverage";
const coverageMeasure = (
	name: string,
	kind: string,
	calculation: "last" | "max",
	combine: "sum" | "count" | "max",
) => ({
	name,
	metric: COVERAGE,
	calculation,
	combine,
	filters: [
		{ field: 'attributes["coverage"]', op: "eq" as const, values: [kind] },
	],
});

/**
 * How many processes the collector's capped per-process detail shows, from its coverage
 * counters: the latest count per node, summed, and whether the cap left any out.
 */
export function useProcessCoverage(
	userId: string,
	reference: ProjectReference,
	scope: { range: Parameters<typeof resolveRange>[0]; filters: Filter[] },
	enabled: boolean,
) {
	const zone = useDisplayTimeZone();
	// Relative ranges resolve to the minute, so the query key stays put between renders.
	const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
	const { from, to } = resolveRange(scope.range, now, zone, getLocale());
	const query: AnalyticsQuery = {
		shape: "table",
		range: { from: from.toISOString(), to: (to ?? now).toISOString() },
		measures: [
			coverageMeasure("shown", "detail_emitted", "last", "sum"),
			coverageMeasure("total", "verified", "last", "sum"),
			coverageMeasure("nodes", "verified", "last", "count"),
			coverageMeasure("deferred", "detail_deferred", "max", "max"),
		],
		// Coverage is per node, so only node filters apply to it.
		filters: scope.filters.filter(
			({ field }) => field === "node" || field === "host",
		),
	};
	return useQuery({
		queryKey: ["process-coverage", userId, reference.projectId, query],
		queryFn: async ({ signal }) => {
			const result = unwrapOperation(
				await runAnalyticsQuery({ data: { ...reference, query }, signal }),
			);
			const value = (name: string) =>
				result.series.find((series) => series.measure === name)?.points[0]
					?.value ?? 0;
			return {
				shown: value("shown"),
				total: value("total"),
				nodes: value("nodes"),
				deferred: value("deferred"),
			};
		},
		enabled,
		staleTime: 60_000,
		retry: false,
	});
}
