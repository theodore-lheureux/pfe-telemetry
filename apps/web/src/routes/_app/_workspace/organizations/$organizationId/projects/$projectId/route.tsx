import { createFileRoute, Outlet } from "@tanstack/react-router";
import { getProject } from "@/organizations/organization.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId",
)({
	beforeLoad: async ({ params, location }) => ({
		project: routeData(
			await getProject({ data: projectParams(params) }),
			location.href,
		),
	}),
	staleTime: 0,
	gcTime: 0,
	component: Outlet,
});
