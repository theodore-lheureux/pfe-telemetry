import { createFileRoute } from "@tanstack/react-router";
import { getMetricDefinition } from "@/definitions/definitions.functions";
import { MetricDetailPage } from "@/definitions/metric-detail";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric",
)({
	loader: async ({ params, location }) =>
		routeData(
			await getMetricDefinition({
				data: { ...projectParams(params), metric: params.metric },
			}),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Metric,
});

function Metric() {
	const { user, project } = Route.useRouteContext();
	const params = Route.useParams();
	const reference = projectParams(params);
	return (
		<MetricDetailPage
			key={`${user.id}/${reference.projectId}/${params.metric}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			detail={Route.useLoaderData()}
		/>
	);
}
