import { getLocale } from "@recount/i18n/runtime";
import { hashKey, keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { resolveRange } from "../components/date-range/date-range";
import { useDisplayTimeZone } from "../components/time-display";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { listActivityPoints } from "./activity.functions";
import type { ExplorerInput, PointCursor, PointPage } from "./contracts";
import type { ExplorerSelection } from "./explorer-filters";

/**
 * The request for one Explorer page. Relative ranges resolve against `now`; a cursor
 * carries the bounds of its first page, which the reader uses instead.
 */
export function explorerRequest(
	reference: ProjectReference,
	selection: ExplorerSelection,
	fields: string[],
	cursor: PointCursor | undefined,
	now: Date,
	zone: string,
	locale: string,
): ExplorerInput {
	return {
		...reference,
		...resolveRange(selection.range, now, zone, locale),
		metric: selection.metric,
		filters: selection.filters,
		fields,
		cursor,
	};
}

/** One page of stored points; the loader's first page seeds the matching query. */
export function useExplorerPoints({
	userId,
	reference,
	selection,
	fields,
	cursor,
	generation,
	enabled,
	initial,
}: {
	userId: string;
	reference: ProjectReference;
	selection: ExplorerSelection;
	fields: string[];
	cursor: PointCursor | undefined;
	generation: number;
	enabled: boolean;
	initial: PointPage | undefined;
}) {
	const locale = getLocale(),
		zone = useDisplayTimeZone();
	const queryKey = [
		"activity",
		userId,
		reference.organizationId,
		reference.projectId,
		selection,
		fields,
		cursor,
		generation,
	];
	// The loader fetched the page for the first render's query, and only that one.
	const [initialKey] = useState(() => hashKey(queryKey));
	return useQuery<PointPage>({
		queryKey,
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await listActivityPoints({
					data: explorerRequest(
						reference,
						selection,
						fields,
						cursor,
						new Date(),
						zone,
						locale,
					),
					signal,
				}),
			),
		initialData: hashKey(queryKey) === initialKey ? initial : undefined,
		enabled,
		// Keep the current rows on screen while a reload or another page loads.
		placeholderData: keepPreviousData,
		retry: false,
		staleTime: 1000,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnMount: false,
	});
}
