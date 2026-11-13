import { createFileRoute } from "@tanstack/react-router";
import { DashboardList } from "@/analytics/dashboards/dashboard-list";
import { listDashboards } from "@/analytics/dashboards.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/dashboards/",
)({
	loader: async ({ params, location }) =>
		routeData(
			await listDashboards({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Dashboards,
});

function Dashboards() {
	const { user, project } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	return (
		<DashboardList
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			dashboards={Route.useLoaderData()}
		/>
	);
}
