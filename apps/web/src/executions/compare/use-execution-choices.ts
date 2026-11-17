import { useInfiniteQuery } from "@tanstack/react-query";
import { unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { listExecutions } from "../execution.functions";

/** The project's executions in key order, a page at a time, once the picker opens. */
export function useExecutionChoices(
	userId: string,
	reference: ProjectReference,
	enabled: boolean,
) {
	const query = useInfiniteQuery({
		queryKey: ["execution-choices", userId, reference.projectId],
		queryFn: async ({ pageParam, signal }) =>
			unwrapOperation(
				await listExecutions({
					data: pageParam ? { ...reference, afterKey: pageParam } : reference,
					signal,
				}),
			),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		staleTime: 60_000,
		retry: false,
	});
	return {
		...query,
		executions: query.data?.pages.flatMap((page) => page.executions) ?? [],
	};
}
