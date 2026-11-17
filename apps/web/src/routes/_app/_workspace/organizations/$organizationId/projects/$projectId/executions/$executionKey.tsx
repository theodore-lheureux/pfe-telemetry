import { m } from "@recount/i18n/messages";
import { useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	notFound,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { RefreshControl } from "@/analytics/dashboards/refresh-control";
import { PageHeading } from "@/components/workspace";
import { getExecution } from "@/executions/execution.functions";
import { ExecutionMeasurements } from "@/executions/execution-measurements";
import {
	applySelection,
	parseExecutionSearch,
	type SelectionPatch,
} from "@/executions/execution-search";
import { ExecutionSummary } from "@/executions/execution-summary";
import { ExecutionTimeline } from "@/executions/execution-timeline";
import { latestBucket } from "@/executions/instant";
import { executionSpan, isLive } from "@/executions/timeline";
import {
	executionMeasurementsKey,
	useExecutionMeasurements,
} from "@/executions/use-execution-measurements";
import { parseExecutionReference } from "@/executions/validation";
import { routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/$executionKey",
)({
	// The selected machine and instant live in the URL so a view can be shared.
	validateSearch: parseExecutionSearch,
	loader: async ({ params, location }) => {
		let reference: ReturnType<typeof parseExecutionReference>;
		try {
			reference = parseExecutionReference(params);
		} catch {
			throw notFound();
		}
		const entry = routeData(
			await getExecution({ data: reference }),
			location.href,
		);
		return { entry };
	},
	staleTime: 0,
	gcTime: 0,
	// Selecting a machine or instant changes only the search; facts reload when the page
	// is entered or refreshed.
	shouldReload: ({ cause }) => cause === "enter",
	component: Execution,
});

function Execution() {
	const { entry } = Route.useLoaderData();
	const { user } = Route.useRouteContext();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();
	const hydrated = useHydrated();
	const reference = useMemo(
		() => ({
			organizationId: entry.organizationId,
			projectId: entry.projectId,
			executionKey: entry.executionKey,
		}),
		[entry.organizationId, entry.projectId, entry.executionKey],
	);
	const nodes = useMemo(
		() => [...new Set(entry.facts.map((fact) => fact.nodeId))],
		[entry.facts],
	);
	// A machine that is no longer part of the execution is ignored, not an error.
	const node =
		search.node && nodes.includes(search.node) ? search.node : undefined;
	const measurements = useExecutionMeasurements(user.id, reference, node);
	const span = executionSpan(entry.facts);
	const live = isLive(entry.facts);
	const at = search.at === undefined ? undefined : Date.parse(search.at);
	const result = measurements.data;
	const nodeLabel = (id: string) => entry.nodeNames[id] ?? id;
	const select = (patch: SelectionPatch) =>
		void navigate({
			search: (previous) => applySelection(previous, patch),
			replace: true,
			resetScroll: false,
		});
	const refresh = useCallback(() => {
		void router.invalidate({ filter: (match) => match.routeId === Route.id });
		void queryClient.invalidateQueries({
			queryKey: executionMeasurementsKey(user.id, reference),
		});
	}, [router, queryClient, user.id, reference]);
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageHeading title={entry.name}>
					{m.execution_key()}: <code>{entry.executionKey}</code>
				</PageHeading>
				{live && (
					<RefreshControl
						// One auto refresh choice covers every execution in the project.
						storageId={`executions:${entry.projectId}`}
						label={m.overview_refresh()}
						refreshedAt={new Date(measurements.dataUpdatedAt || Date.now())}
						progress={null}
						disabled={!hydrated || measurements.isFetching}
						onRefresh={refresh}
					/>
				)}
			</div>
			<ExecutionSummary entry={entry} />
			{span && (
				<ExecutionTimeline
					facts={entry.facts}
					nodeNames={entry.nodeNames}
					span={span}
					selectedNode={node}
					instant={at ?? (result ? latestBucket(result) : span.to)}
					selectedInstant={at !== undefined}
					step={(result?.bucketSeconds ?? 1) * 1000}
					onSelect={select}
				/>
			)}
			<ExecutionMeasurements
				measurements={measurements}
				nodes={node ? [node] : nodes}
				nodeLabel={nodeLabel}
				selectedNode={node}
				at={at}
				onSelect={select}
			/>
		</div>
	);
}
