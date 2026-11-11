import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { LineChartIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { LoadingBar } from "../../components/loading-bar";
import { useDisplayTimeZone } from "../../components/time-display";
import { Skeleton } from "../../components/ui/skeleton";
import { IconEmptyState } from "../../components/workspace";
import { operationMessage } from "../../lib/operation-message";
import { MutationFailure, unwrapOperation } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { runAnalyticsQuery } from "../analytics.functions";
import type { MetricDefinition, QueryResult } from "../contracts";
import { InsightsHeader } from "../insights-header";
import { formulaNames, type InsightDraft, toQuery } from "./draft";
import { InsightChart } from "./insight-chart";
import { InsightTable } from "./insight-table";
import { InsightToolbar } from "./insight-toolbar";
import { QueryPanel } from "./query-panel";
import { seriesView } from "./series-view";

// Edits apply after a short pause, so typing a formula doesn't run a query per keystroke.
const APPLY_DELAY_MS = 400;

/** Builds an insight: series, formula, filters and breakdown on the left, the result on the right. */
export function InsightEditor({
	userId,
	reference,
	metrics,
	nodes,
	draft,
	onDraft,
}: {
	userId: string;
	reference: ProjectReference;
	metrics: MetricDefinition[];
	nodes: { id: string; hostname: string }[];
	draft: InsightDraft;
	onDraft: (draft: InsightDraft) => void;
}) {
	const hydrated = useHydrated();
	const locale = getLocale(),
		zone = useDisplayTimeZone();
	const usable = useMemo(
		() => metrics.filter((metric) => metric.behavior !== "unsupported"),
		[metrics],
	);
	const nodeNames = useMemo(
		() => new Map(nodes.map((node) => [node.id, node.hostname])),
		[nodes],
	);
	const [hovered, setHovered] = useState<string | null>(null);
	const [applied, setApplied] = useState(draft),
		// Relative ranges resolve when a query is applied or refreshed, not on every render.
		[now, setNow] = useState(() => new Date());
	useEffect(() => {
		if (draft === applied) return;
		const timer = setTimeout(() => {
			setApplied(draft);
			setNow(new Date());
		}, APPLY_DELAY_MS);
		return () => clearTimeout(timer);
	}, [draft, applied]);
	const query = useMemo(
		() => toQuery(applied, now, zone, locale),
		[applied, now, zone, locale],
	);
	const result = useQuery<QueryResult>({
		queryKey: ["analytics-query", userId, reference.projectId, query],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await runAnalyticsQuery({
					data: { ...reference, query: query as NonNullable<typeof query> },
					signal,
				}),
			),
		enabled: hydrated && query !== null,
		placeholderData: keepPreviousData,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const groupLabel = (value: string | null) => {
		if (value === null) return "—";
		if (applied.groupBy !== "node") return value;
		return nodeNames.get(value) ?? value;
	};
	const names = formulaNames(applied);
	const view =
		result.data &&
		seriesView(result.data, applied.display, groupLabel, names, locale);
	return (
		<section className="flex min-w-0 flex-col gap-5">
			<InsightsHeader tab="explore" reference={reference} />
			{usable.length === 0 ? (
				<IconEmptyState
					icon={<LineChartIcon aria-hidden="true" />}
					title={m.insight_no_metrics()}
					description={m.insight_no_metrics_description()}
					className="bg-card"
				/>
			) : (
				<div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
					<QueryPanel
						userId={userId}
						reference={reference}
						draft={draft}
						metrics={usable}
						disabled={!hydrated}
						onChange={onDraft}
					/>
					<div className="flex min-w-0 flex-col gap-4">
						<div
							aria-busy={result.isFetching}
							className="relative flex flex-col gap-4 overflow-hidden rounded-lg border bg-card p-4"
						>
							<LoadingBar active={result.isFetching && !!result.data} />
							<InsightToolbar
								draft={draft}
								disabled={!hydrated}
								onChange={onDraft}
							/>
							<ResultState ready={query !== null} error={result.error}>
								{view && result.data && (
									<InsightChart
										result={result.data}
										view={view}
										display={applied.display}
										hydrated={hydrated}
										fetching={result.isFetching}
										computedAt={
											// Placeholder data is the previous result; its new time is not known yet.
											result.isPlaceholderData
												? null
												: new Date(result.dataUpdatedAt)
										}
										names={names}
										onRefresh={() => setNow(new Date())}
										highlight={hovered}
										onZoom={(from, to) =>
											onDraft({
												...draft,
												range: { kind: "between", from, to },
											})
										}
									/>
								)}
							</ResultState>
						</div>
						{view && result.data && query !== null && !result.isError && (
							<div className="rounded-lg border bg-card p-4">
								<InsightTable
									result={result.data}
									view={view}
									hydrated={hydrated}
									onHover={setHovered}
								/>
							</div>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

/** Before a query can run, when it failed, or while its first result loads. */
function ResultState({
	ready,
	error,
	children,
}: {
	ready: boolean;
	error: Error | null;
	children: ReactNode;
}) {
	if (!ready)
		return (
			<IconEmptyState
				icon={<LineChartIcon aria-hidden="true" />}
				title={m.insight_start()}
				description={m.insight_start_description()}
				className="h-80"
			/>
		);
	if (error)
		return (
			<IconEmptyState
				icon={<TriangleAlertIcon aria-hidden="true" />}
				title={m.insight_unavailable()}
				description={
					error instanceof MutationFailure
						? operationMessage(error.failure)
						: undefined
				}
				alert
				className="h-80"
			/>
		);
	if (!children) return <Skeleton className="h-80 w-full" />;
	return children;
}
