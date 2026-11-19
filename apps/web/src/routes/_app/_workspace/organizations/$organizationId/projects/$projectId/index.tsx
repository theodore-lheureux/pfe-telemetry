import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/analytics/dashboards/dashboard-page";
import { NodeHealthOverview } from "@/analytics/dashboards/node-health-overview";
import { getProjectHome } from "@/analytics/dashboards.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/",
)({
	// A home dashboard's overrides live in the URL until they are saved, as on its page.
	validateSearch: (search: Record<string, unknown>): { filters?: string } =>
		typeof search.filters === "string" ? { filters: search.filters } : {},
	loader: async ({ params, location }) => {
		const reference = projectParams(params);
		const home = routeData(
			await getProjectHome({ data: reference }),
			location.href,
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
	const onFilters = (next: string | undefined) =>
		void navigate({
			search: next === undefined ? {} : { filters: next },
			replace: true,
			resetScroll: false,
		});
	if (home)
		return (
			<DashboardPage
				key={`${user.id}/${home.id}`}
				userId={user.id}
				reference={reference}
				canWrite={project.role !== "viewer"}
				dashboard={home}
				urlFilters={filters}
				onFilters={onFilters}
			/>
		);
	return (
		<NodeHealthOverview
			key={`${user.id}/${reference.projectId}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			urlFilters={filters}
			onFilters={onFilters}
		/>
	);
}
