import { createFileRoute } from "@tanstack/react-router";
import { OVERVIEW_SECTIONS } from "@/analytics/contracts";
import { DashboardPage } from "@/analytics/dashboards/dashboard-page";
import { getProjectHome } from "@/analytics/dashboards.functions";
import { FleetOverview } from "@/analytics/overview/overview-page";
import {
	DEFAULT_OVERVIEW_RANGE,
	overviewSectionQuery,
} from "@/analytics/overview/overview-query";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/",
)({
	// A home dashboard's overrides live in the URL until they are saved, as on its page.
	validateSearch: (search: Record<string, unknown>): { filters?: string } =>
		typeof search.filters === "string" ? { filters: search.filters } : {},
	// The project opens on its chosen dashboard, or on the fleet overview. The overview's
	// sections start here without blocking the page: the server streams each result into
	// the query cache when it arrives. Hovering a link only preloads, so it starts nothing.
	loader: async ({ params, context, preload, location }) => {
		const reference = projectParams(params);
		const home = routeData(
			await getProjectHome({ data: reference }),
			location.href,
		);
		if (!home && !preload)
			for (const section of OVERVIEW_SECTIONS)
				void context.queryClient.prefetchQuery(
					overviewSectionQuery(
						context.user.id,
						reference,
						DEFAULT_OVERVIEW_RANGE,
						section,
					),
				);
		return home;
	},
	staleTime: 0,
	gcTime: 0,
	// Changing a home dashboard's overrides only changes the URL.
	shouldReload: ({ cause }) => cause === "enter",
	component: Home,
});

function Home() {
	const { user, project } = Route.useRouteContext();
	const reference = projectParams(Route.useParams());
	const home = Route.useLoaderData();
	const { filters } = Route.useSearch();
	const navigate = Route.useNavigate();
	if (home)
		return (
			<DashboardPage
				key={`${user.id}/${home.id}`}
				userId={user.id}
				reference={reference}
				canWrite={project.role !== "viewer"}
				dashboard={home}
				urlFilters={filters}
				onFilters={(next) =>
					void navigate({
						search: next === undefined ? {} : { filters: next },
						replace: true,
						resetScroll: false,
					})
				}
			/>
		);
	return (
		<FleetOverview
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
		/>
	);
}
