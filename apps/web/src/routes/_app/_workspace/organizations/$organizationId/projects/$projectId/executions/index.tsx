import { m } from "@recount/i18n/messages";
import {
	createFileRoute,
	Link,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { ListIcon } from "lucide-react";
import { settingsSearch } from "@/components/settings-links";
import { Button } from "@/components/ui/button";
import {
	EmptyState,
	IconEmptyState,
	PageHeading,
} from "@/components/workspace";
import { listExecutions } from "@/executions/execution.functions";
import { ExecutionFilterBar } from "@/executions/execution-filter-bar";
import { ExecutionResults } from "@/executions/execution-results";
import { useExecutionFilterOptions } from "@/executions/use-execution-filter-options";
import { useSearchText } from "@/executions/use-search-text";
import {
	type ExecutionSearch,
	hasExecutionFilters,
	parseExecutionSearch,
	searchFilters,
} from "@/executions/validation";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/",
)({
	validateSearch: parseExecutionSearch,
	loaderDeps: ({ search }) => search,
	loader: async ({ params, deps, location }) => {
		const result = await listExecutions({
			data: {
				...projectParams(params),
				...searchFilters(deps),
				...(deps.afterKey ? { afterKey: deps.afterKey } : {}),
			},
		});
		// Access failures leave the page; telemetry failures keep the filters usable.
		if (!result.error || ACCESS_ERRORS.has(result.error.code))
			return { page: routeData(result, location.href), error: null };
		return { page: null, error: result.error };
	},
	staleTime: 0,
	gcTime: 0,
	component: Executions,
});

const ACCESS_ERRORS = new Set(["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"]);

function Executions() {
	const { page, error } = Route.useLoaderData();
	const params = Route.useParams();
	const search = Route.useSearch();
	const { user, project } = Route.useRouteContext();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const hydrated = useHydrated();
	const busy = Route.useMatch({ select: (match) => !!match.isFetching });
	const filtered = hasExecutionFilters(search);
	const unused = !filtered && !search.afterKey && page?.executions.length === 0;
	const options = useExecutionFilterOptions(
		user.id,
		projectParams(params),
		hydrated && !unused,
	);
	const change = (patch: Partial<ExecutionSearch>, replace = false) =>
		void navigate({
			search: (previous) => ({ ...previous, ...patch, afterKey: undefined }),
			replace,
			resetScroll: false,
		});
	// Typing replaces the history entry rather than adding one per pause.
	const text = useSearchText(search.q, (q) => change({ q }, true));
	const clear = () => {
		text.reset();
		void navigate({ search: {}, resetScroll: false });
	};
	const paged = !!search.afterKey || !!page?.nextCursor;
	return (
		<>
			<PageHeading title={m.executions()} />
			{!unused && (
				<ExecutionFilterBar
					search={search}
					text={text}
					options={options.data}
					disabled={!hydrated}
					onChange={change}
					onClear={clear}
				/>
			)}
			<p role="status" className="sr-only">
				{busy ? m.loading() : ""}
			</p>
			<ExecutionResults
				page={page}
				error={error}
				filtered={filtered}
				busy={busy}
				onClear={clear}
				onRetry={() =>
					void router.invalidate({
						filter: (match) => match.routeId === Route.id,
					})
				}
				open={(entry) => (
					<Link
						to="/organizations/$organizationId/projects/$projectId/executions/$executionKey"
						params={{ ...params, executionKey: entry.executionKey }}
						// Covers the row, so clicking anywhere on it opens the execution.
						className="min-w-0 truncate font-medium after:absolute after:inset-0 hover:underline"
					>
						{entry.name}
					</Link>
				)}
				empty={
					search.afterKey ? (
						<EmptyState title={m.no_executions_recorded_on_this_page()} />
					) : (
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
					)
				}
			/>
			{paged && (
				<nav aria-label={m.execution_pages()} className="flex gap-2">
					<Button asChild variant="outline" size="sm">
						<Link
							from={Route.fullPath}
							search={(previous) => ({ ...previous, afterKey: undefined })}
						>
							{m.execution_first_page()}
						</Link>
					</Button>
					{page?.nextCursor && (
						<Button asChild variant="outline" size="sm">
							<Link
								from={Route.fullPath}
								search={(previous) => ({
									...previous,
									afterKey: page.nextCursor ?? undefined,
								})}
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
