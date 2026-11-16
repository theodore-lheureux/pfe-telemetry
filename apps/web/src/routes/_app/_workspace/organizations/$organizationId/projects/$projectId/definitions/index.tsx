import { createFileRoute } from "@tanstack/react-router";
import { listMetricDefinitions } from "@/definitions/definitions.functions";
import { MetricList } from "@/definitions/metric-list";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/definitions/",
)({
	loader: async ({ params, location }) =>
		routeData(
			await listMetricDefinitions({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Metrics,
});

function Metrics() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	return (
		<MetricList
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			metrics={Route.useLoaderData()}
		/>
	);
}
