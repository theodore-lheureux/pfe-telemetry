import { createFileRoute, notFound } from "@tanstack/react-router";
import { analyticsCatalogQuery } from "@/analytics/catalog";
import { getExecution } from "@/executions/execution.functions";
import { ExecutionDashboard } from "@/executions/execution-dashboard";
import { parseExecutionReference } from "@/executions/validation";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/$executionKey_/dashboard",
)({
	// Overrides live in the URL, as on a dashboard page; there is nothing to save them to.
	validateSearch: (search: Record<string, unknown>): { filters?: string } =>
		typeof search.filters === "string" ? { filters: search.filters } : {},
	loader: async ({ params, context, location }) => {
		let reference: ReturnType<typeof parseExecutionReference>;
		try {
			reference = parseExecutionReference(params);
		} catch {
			throw notFound();
		}
		// The catalog never fails the page; the dashboard reports its own error.
		const [execution] = await Promise.all([
			getExecution({ data: reference }),
			context.queryClient.prefetchQuery(
				analyticsCatalogQuery(context.user.id, projectParams(params)),
			),
		]);
		return routeData(execution, location.href);
	},
	staleTime: 0,
	gcTime: 0,
	// Changing the overrides only changes the URL.
	shouldReload: ({ cause }) => cause === "enter",
	component: ExecutionDashboardRoute,
});

function ExecutionDashboardRoute() {
	const { user, project } = Route.useRouteContext();
	const execution = Route.useLoaderData();
	const { filters } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ExecutionDashboard
			key={`${user.id}/${project.id}/${execution.executionKey}`}
			userId={user.id}
			execution={execution}
			canWrite={project.role !== "viewer"}
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
