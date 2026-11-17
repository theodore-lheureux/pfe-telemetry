import { m } from "@recount/i18n/messages";
import { getRouteApi } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { useId } from "react";
import { QueryUnavailable } from "../components/query-unavailable";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { IconEmptyState } from "../components/workspace";
import type { ExecutionReference } from "./contracts";
import { OverlapLoadChart } from "./overlap-load-chart";
import { OverlapTable } from "./overlap-table";
import { OVERLAP_LIMIT } from "./overlaps";
import { useExecutionOverlaps } from "./use-execution-overlaps";

type Queries = ReturnType<typeof useExecutionOverlaps>;

function OverlapList({
	reference,
	query,
}: {
	reference: ExecutionReference;
	query: Queries["overlaps"];
}) {
	if (query.error)
		return (
			<QueryUnavailable
				title={m.execution_overlap_unavailable()}
				error={query.error}
				heading="h3"
				className="bg-card"
			/>
		);
	if (!query.data) return <Skeleton className="h-32 w-full" />;
	if (!query.data.executions.length)
		return (
			<IconEmptyState
				icon={<LayersIcon aria-hidden="true" />}
				title={m.execution_overlap_empty()}
				description={m.execution_overlap_empty_description()}
				heading="h3"
				className="bg-card"
			/>
		);
	return (
		<div className="flex flex-col gap-2">
			<OverlapTable project={reference} overlaps={query.data} />
			{query.data.more && (
				<p className="text-sm text-muted-foreground">
					{m.execution_overlap_more({ count: OVERLAP_LIMIT })}
				</p>
			)}
		</div>
	);
}

function LoadSplit({ query }: { query: Queries["load"] }) {
	if (query.error)
		return (
			<QueryUnavailable
				title={m.execution_overlap_load_unavailable()}
				error={query.error}
				heading="h4"
			/>
		);
	if (!query.data)
		return (
			<div className="grid gap-4 lg:grid-cols-2">
				<Skeleton className="h-64 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	return (
		<div className="grid gap-6 lg:grid-cols-2">
			<OverlapLoadChart load={query.data} metric="cpu" />
			<OverlapLoadChart load={query.data} metric="memory" />
		</div>
	);
}

/**
 * Other workloads of the execution's project on its nodes while it ran. Other projects'
 * workloads are never read, so they can be neither shown nor inferred.
 */
export function OverlappingWorkloads({
	reference,
}: {
	reference: ExecutionReference;
}) {
	const { user } = getRouteApi("/_app").useRouteContext();
	const queries = useExecutionOverlaps(user.id, reference);
	const heading = useId();
	return (
		<section aria-labelledby={heading} className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-col gap-1">
				<h2 id={heading} className="text-lg font-semibold text-balance">
					{m.execution_overlap_title()}
				</h2>
				<p className="max-w-3xl text-sm text-pretty text-muted-foreground">
					{m.execution_overlap_description()} {m.execution_overlap_scope()}
				</p>
			</div>
			<OverlapList reference={reference} query={queries.overlaps} />
			<Card>
				<CardHeader>
					<CardTitle>
						<h3 className="text-balance">{m.execution_overlap_load_title()}</h3>
					</CardTitle>
					<p className="text-sm text-pretty text-muted-foreground">
						{m.execution_overlap_load_description()}
					</p>
				</CardHeader>
				<CardContent>
					<LoadSplit query={queries.load} />
				</CardContent>
			</Card>
		</section>
	);
}
