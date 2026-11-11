import { createFileRoute } from "@tanstack/react-router";
import { ActivityPage } from "@/activity/activity-page";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/activity/live",
)({
	staleTime: 0,
	gcTime: 0,
	component: Live,
});
function Live() {
	const { user } = Route.useRouteContext(),
		reference = projectParams(Route.useParams());
	return (
		<ActivityPage
			key={`${user.id}/${reference.projectId}/live`}
			mode="live"
			userId={user.id}
			reference={reference}
		/>
	);
}
