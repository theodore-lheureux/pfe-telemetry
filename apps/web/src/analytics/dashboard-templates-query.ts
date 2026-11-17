import { useQuery } from "@tanstack/react-query";
import { unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { builtInDashboardTemplates } from "./dashboard-templates";
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

/** Built-in templates followed by this project's saved templates. */
export function useTemplateChoices(
	userId: string,
	reference: ProjectReference,
	enabled: boolean,
) {
	const projects = useQuery({ ...templatesQuery(userId, reference), enabled });
	return {
		choices: [...builtInDashboardTemplates(), ...(projects.data ?? [])],
		projects,
	};
}
