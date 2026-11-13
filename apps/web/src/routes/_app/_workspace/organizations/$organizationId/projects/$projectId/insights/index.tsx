import { createFileRoute } from "@tanstack/react-router";
import { OVERVIEW_SECTIONS } from "@/analytics/contracts";
import { FleetOverview } from "@/analytics/overview/overview-page";
import {
	DEFAULT_OVERVIEW_RANGE,
	overviewSectionQuery,
} from "@/analytics/overview/overview-query";
import { projectParams } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights/",
)({
	// The overview's sections start here without blocking the page: the server streams
	// each result into the query cache when it arrives. Hovering a link only preloads,
	// so it starts nothing.
	loader: ({ params, context, preload }) => {
		if (preload) return;
		for (const section of OVERVIEW_SECTIONS)
			void context.queryClient.prefetchQuery(
				overviewSectionQuery(
					context.user.id,
					projectParams(params),
					DEFAULT_OVERVIEW_RANGE,
					section,
				),
			);
	},
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
		/>
	);
}
