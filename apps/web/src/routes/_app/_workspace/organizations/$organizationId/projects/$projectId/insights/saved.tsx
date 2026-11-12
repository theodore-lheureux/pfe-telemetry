import { createFileRoute } from "@tanstack/react-router";
import { listSavedInsights } from "@/analytics/analytics.functions";
import { SavedInsights } from "@/analytics/saved/saved-list";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/saved",
)({
	loader: async ({ params, location }) =>
		routeData(
			await listSavedInsights({ data: projectParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Saved,
});

function Saved() {
	const { user, project } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	return (
		<SavedInsights
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			insights={Route.useLoaderData()}
		/>
	);
}
