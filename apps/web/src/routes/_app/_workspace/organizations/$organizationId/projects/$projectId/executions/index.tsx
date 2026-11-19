import { m } from "@recount/i18n/messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListIcon } from "lucide-react";
import { FormFeedback } from "@/components/form-feedback";
import { settingsSearch } from "@/components/settings-links";
import { Button } from "@/components/ui/button";
import {
	EmptyState,
	IconEmptyState,
	PageHeading,
} from "@/components/workspace";
import { listExecutions } from "@/executions/execution.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/",
)({
	validateSearch: (search: Record<string, unknown>): { afterKey?: string } => ({
		afterKey: typeof search.afterKey === "string" ? search.afterKey : undefined,
	}),
	loaderDeps: ({ search }) => ({ afterKey: search.afterKey }),
	loader: async ({ params, deps, location }) => {
		const reference = projectParams(params);
		const result = await listExecutions({ data: { ...reference, ...deps } });
		// A telemetry outage should not break navigation or workspace mutations.
		if (result.error?.code === "UNAVAILABLE") return null;
		return routeData(result, location.href);
	},
	staleTime: 0,
	gcTime: 0,
	component: Executions,
});

function Executions() {
	const page = Route.useLoaderData();
	const params = Route.useParams();
	const { afterKey } = Route.useSearch();
	const { project } = Route.useRouteContext();
	if (!page)
		return (
			<>
				<PageHeading title={m.executions()} />
				<FormFeedback kind="error" message={m.insight_unavailable()} />
			</>
		);
	const paged = !!afterKey || !!page.nextCursor;
	const empty = page.executions.length === 0;
	return (
		<>
			<PageHeading title={m.executions()} />
			{empty && afterKey && (
				<EmptyState title={m.no_executions_recorded_on_this_page()} />
			)}
			{empty && !afterKey && (
				<IconEmptyState
					icon={<ListIcon aria-hidden="true" />}
					title={m.executions_empty_title()}
					description={m.execution_claims_hint()}
					className="bg-card"
				>
					{project.role === "admin" && (
						<Button asChild variant="outline">
							<Link
								to="/settings"
								search={settingsSearch("collectors", params)}
							>
								{m.settings_manage_credentials()}
							</Link>
						</Button>
					)}
				</IconEmptyState>
			)}
			{!empty && (
				<ul className="divide-y rounded-md border bg-card text-card-foreground">
					{page.executions.map((entry) => (
						<li key={entry.executionKey} className="p-4">
							<Link
								to="/organizations/$organizationId/projects/$projectId/executions/$executionKey"
								params={{ ...params, executionKey: entry.executionKey }}
								className="font-semibold underline"
							>
								{entry.name}
							</Link>
							<p className="text-sm text-muted-foreground">
								{m.execution_key()}: <code>{entry.executionKey}</code>
							</p>
							{entry.workloadVersion && (
								<p className="text-sm">
									{m.execution_workload_version()}: {entry.workloadVersion}
								</p>
							)}
						</li>
					))}
				</ul>
			)}
			{paged && (
				<nav aria-label={m.execution_pages()} className="flex gap-2">
					<Button asChild variant="outline" size="sm">
						<Link
							to="/organizations/$organizationId/projects/$projectId/executions"
							params={params}
							search={{}}
						>
							{m.execution_first_page()}
						</Link>
					</Button>
					{page.nextCursor && (
						<Button asChild variant="outline" size="sm">
							<Link
								to="/organizations/$organizationId/projects/$projectId/executions"
								params={params}
								search={{ afterKey: page.nextCursor }}
							>
								{m.execution_next_page()}
							</Link>
						</Button>
					)}
				</nav>
			)}
		</>
	);
}
