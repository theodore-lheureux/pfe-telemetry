import { createFileRoute } from "@tanstack/react-router";
import { getFleetOverview } from "@/analytics/analytics.functions";
import { FleetOverview } from "@/analytics/fleet-overview";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/",
)({
	loader: async ({ params, location }) =>
		routeData(
			await getFleetOverview({
				data: { ...projectParams(params), range: "1h" },
			}),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Overview,
});

function Overview() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	return (
		<FleetOverview
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			initial={Route.useLoaderData()}
		/>
	);
}
