import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
	getOrganization,
	listProjects,
} from "@/organizations/organization.functions";
import { organizationParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId",
)({
	beforeLoad: async ({ params, location }) => {
		const data = organizationParams(params);
		const [organization, projects] = await Promise.all([
			getOrganization({ data }),
			listProjects({ data }),
		]);
		return {
			organization: routeData(organization, location.href),
			projects: routeData(projects, location.href),
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Outlet,
});
