import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RouteError, RouteNotFound } from "@/components/route-feedback";
import { routeData } from "@/organizations/route-data";
import { getWorkspaceSelection } from "@/organizations/workspace-selection.functions";

export const Route = createFileRoute("/_app/_workspace")({
	beforeLoad: async ({ location, params }) => {
		const search = location.search as Record<string, unknown>;
		const routeParams = params as {
			organizationId?: string;
			projectId?: string;
		};
		const selected = routeData(
			await getWorkspaceSelection({
				data: {
					organizationId:
						routeParams.organizationId ??
						(typeof search.organizationId === "string"
							? search.organizationId
							: undefined),
					projectId:
						routeParams.projectId ??
						(typeof search.projectId === "string"
							? search.projectId
							: undefined),
				},
			}),
			location.href,
		);
		return {
			organizations: selected.organizations,
			workspaceOrganization: selected.organization,
			workspaceProject: selected.project,
			workspaceProjects: selected.projects,
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Outlet,
	// Keep the app shell around errors and missing pages inside the workspace.
	errorComponent: RouteError,
	notFoundComponent: RouteNotFound,
});
