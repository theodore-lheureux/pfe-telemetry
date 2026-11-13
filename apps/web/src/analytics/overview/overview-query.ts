import { queryOptions } from "@tanstack/react-query";
import {
	type OperationResult,
	unwrapOperation,
} from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { getOverviewSection } from "../analytics.functions";
import type { OverviewSection, QueryRange } from "../contracts";
import type { OverviewSectionResult } from "../overview.server";

/** The overview's range until the viewer picks another; the server resolves "now". */
export const DEFAULT_OVERVIEW_RANGE: QueryRange = { last: "1h" };

/**
 * One overview section for a range, shared by the route's loader, which starts it, and
 * the page, which reads it, so server-started results land in the page's cache entry.
 */
export function overviewSectionQuery(
	userId: string,
	reference: ProjectReference,
	range: QueryRange,
	section: OverviewSection,
) {
	return queryOptions({
		queryKey: ["fleet-overview", userId, reference.projectId, range, section],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				(await getOverviewSection({
					data: { ...reference, range, section },
					signal,
				})) as OperationResult<OverviewSectionResult | null>,
			),
		retry: false,
		staleTime: 30_000,
		gcTime: 60_000,
	});
}
