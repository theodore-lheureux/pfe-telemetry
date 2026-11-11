import { createFileRoute } from "@tanstack/react-router";
import { getAnalyticsCatalog } from "@/analytics/analytics.functions";
import { InsightBuilder } from "@/analytics/insight-builder";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/explore",
)({
	loader: async ({ params, location }) =>
		routeData(
			await getAnalyticsCatalog({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Insights,
});

function Insights() {
	const { user } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	const catalog = Route.useLoaderData();
	return (
		<InsightBuilder
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			metrics={catalog.metrics}
			nodes={catalog.nodes}
		/>
	);
}
