import { createFileRoute, notFound } from "@tanstack/react-router";
import { DashboardPage } from "@/analytics/dashboards/dashboard-page";
import { getDashboard } from "@/analytics/dashboards.functions";
import { parseUuid } from "@/lib/input";
import { projectParams, routeData } from "@/organizations/route-data";

function dashboardParams(params: {
	organizationId: string;
	projectId: string;
	dashboardId: string;
}) {
	try {
		return {
			...projectParams(params),
			dashboardId: parseUuid(params.dashboardId),
		};
	} catch {
		throw notFound();
	}
}

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/dashboards/$dashboardId",
)({
	// Overrides chosen on the page live in the URL until they are saved to the dashboard.
	validateSearch: (search: Record<string, unknown>): { filters?: string } =>
		typeof search.filters === "string" ? { filters: search.filters } : {},
	loader: async ({ params, location }) =>
		routeData(
			await getDashboard({ data: dashboardParams(params) }),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	// Changing the overrides only changes the URL; data reloads on entry or after a change.
	shouldReload: ({ cause }) => cause === "enter",
	component: Dashboard,
});

function Dashboard() {
	const { user, project } = Route.useRouteContext();
	const params = Route.useParams();
	const reference = projectParams(params);
	const { filters } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<DashboardPage
			key={`${user.id}/${params.dashboardId}`}
			userId={user.id}
			reference={reference}
			canWrite={project.role !== "viewer"}
			dashboard={Route.useLoaderData()}
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
}
