import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { listDashboardTemplates } from "./dashboard-templates.functions";

export function templatesQuery(userId: string, reference: ProjectReference) {
	return {
		queryKey: [
			"dashboard-templates",
			userId,
			reference.organizationId,
			reference.projectId,
		],
		queryFn: async ({ signal }: { signal: AbortSignal }) =>
			unwrapOperation(
				await listDashboardTemplates({ data: reference, signal }),
			),
		staleTime: 0,
	};
}
