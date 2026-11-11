import { createFileRoute } from "@tanstack/react-router";
import { listActivityPoints } from "@/activity/activity.functions";
import { ActivityPage } from "@/activity/activity-page";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/activity/",
)({
	loader: async ({ params }) => ({
		initial: await listActivityPoints({ data: projectParams(params) }),
	}),
	staleTime: 0,
	gcTime: 0,
	component: Explorer,
});
function Explorer() {
	const { user } = Route.useRouteContext(),
		reference = projectParams(Route.useParams());
	return (
		<ActivityPage
			key={`${user.id}/${reference.projectId}/explorer`}
			mode="explorer"
			userId={user.id}
			reference={reference}
			initial={Route.useLoaderData().initial}
		/>
	);
}
