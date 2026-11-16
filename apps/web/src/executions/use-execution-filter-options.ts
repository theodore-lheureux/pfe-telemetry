import { useQuery } from "@tanstack/react-query";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { listExecutionFilterOptions } from "./execution.functions";

/** Names, machines and owners offered by the filters. */
export function useExecutionFilterOptions(
	userId: string,
	reference: ProjectReference,
	enabled: boolean,
) {
	return useQuery({
		queryKey: ["execution-filter-options", userId, reference.projectId],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await listExecutionFilterOptions({ data: reference, signal }),
			),
		enabled,
		staleTime: 60_000,
		retry: false,
	});
}
