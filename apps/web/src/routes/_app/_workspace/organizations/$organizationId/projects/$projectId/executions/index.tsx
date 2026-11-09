import { formatDate } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState, PageHeading } from "@/components/workspace";
import { CreateExecutionForm } from "@/executions/create-execution-form";
import {
	listExecutionSources,
	listExecutions,
} from "@/executions/execution.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/",
)({
	validateSearch: (search: Record<string, unknown>): { beforeId?: string } => ({
		beforeId: typeof search.beforeId === "string" ? search.beforeId : undefined,
	}),
	loaderDeps: ({ search }) => ({ beforeId: search.beforeId }),
	loader: async ({ params, deps, location }) => {
		const reference = projectParams(params);
		const page = routeData(
			await listExecutions({ data: { ...reference, ...deps } }),
			location.href,
		);
		const sources = page.canCreate
			? routeData(
					await listExecutionSources({ data: reference }),
					location.href,
				)
			: [];
		return { ...page, sources };
	},
	staleTime: 0,
	gcTime: 0,
	component: Executions,
});

function Executions() {
	const page = Route.useLoaderData();
	const params = Route.useParams();
	const { user, project } = Route.useRouteContext();
	return (
		<>
			<PageHeading title={m.executions()} />
			{page.executions.length === 0 ? (
				<EmptyState title={m.no_executions_recorded_on_this_page()} />
			) : (
				<ul className="divide-y rounded-md border bg-card text-card-foreground">
					{page.executions.map((entry) => (
						<li key={entry.executionId} className="p-4">
							<Link
								to="/organizations/$organizationId/projects/$projectId/executions/$executionId"
								params={{ ...params, executionId: entry.executionId }}
								className="font-semibold underline"
							>
								{entry.name}
							</Link>
							<p className="text-sm text-muted-foreground">
								{m.context_source_host({
									source: entry.sourceId,
									host: entry.hostId ?? m.all_source_hosts(),
								})}
							</p>
							<p className="text-sm">
								{m.interval_display({
									from: formatDate(
										entry.startedAt,
										undefined,
										project.timeZone,
									),
									to: formatDate(entry.endedAt, undefined, project.timeZone),
									timeZone: project.timeZone,
								})}
							</p>
						</li>
					))}
				</ul>
			)}
			<nav aria-label={m.execution_pages()} className="flex gap-4">
				<Link
					to="/organizations/$organizationId/projects/$projectId/executions"
					params={params}
					search={{}}
				>
					{m.newest_executions()}
				</Link>
				{page.nextCursor && (
					<Link
						to="/organizations/$organizationId/projects/$projectId/executions"
						params={params}
						search={{ beforeId: page.nextCursor }}
					>
						{m.older_executions()}
					</Link>
				)}
			</nav>
			{page.canCreate &&
				(page.sources.length ? (
					<CreateExecutionForm
						key={`${user.id}/${params.projectId}`}
						userId={user.id}
						reference={params}
						sources={page.sources}
					/>
				) : (
					<p>{m.execution_source_required()}</p>
				))}
		</>
	);
}
