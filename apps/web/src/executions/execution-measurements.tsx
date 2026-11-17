import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import type { UseQueryResult } from "@tanstack/react-query";
import { useHydrated } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { MAX_SERIES, type QueryResult } from "../analytics/contracts";
import { DEFAULT_DISPLAY, type Display } from "../analytics/insight/draft";
import { ChartBody } from "../analytics/insight/insight-chart";
import { CALCULATION_LABEL } from "../analytics/insight/labels";
import {
	CHART_SERIES,
	type SeriesView,
	seriesView,
} from "../analytics/insight/series-view";
import { metricLabel } from "../analytics/metric-names";
import { FormFeedback } from "../components/form-feedback";
import { LoadingBar } from "../components/loading-bar";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { IconEmptyState } from "../components/workspace";
import { operationMessage } from "../lib/operation-message";
import { MutationFailure } from "../lib/operation-result";
import type { SelectionPatch } from "./execution-search";
import {
	bucketAt,
	instantValues,
	latestBucket,
	measureResult,
	resultGrid,
	unitText,
} from "./instant";
import { InstantValues } from "./instant-values";

// Machines are named by the legend; the values table below gives exact numbers.
const DISPLAY: Display = { ...DEFAULT_DISPLAY, type: "line", legend: "bottom" };

function MeasurePanel({
	result,
	view,
	marker,
	onSelect,
}: {
	result: QueryResult;
	view: SeriesView;
	marker: number;
	onSelect: (bucketMs: number) => void;
}) {
	const [measure] = result.measures;
	const hydrated = useHydrated();
	if (!measure) return null;
	return (
		<section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
			<div className="flex flex-col gap-0.5">
				<h3 className="font-medium text-balance">
					{metricLabel(measure.metric, measure.label)}
				</h3>
				<p className="text-xs text-muted-foreground">
					{CALCULATION_LABEL[measure.calculation]()} · {unitText(measure)}
				</p>
			</div>
			<ChartBody
				result={result}
				view={view}
				display={DISPLAY}
				hydrated={hydrated}
				highlight={null}
				height="h-52"
				marker={marker}
				onSelect={onSelect}
			/>
			{view.current.length > CHART_SERIES && (
				<p className="text-xs text-muted-foreground">
					{m.insight_chart_limited()}
				</p>
			)}
		</section>
	);
}

function Panels({
	result,
	nodes,
	nodeLabel,
	at,
	onSelect,
}: {
	result: QueryResult;
	nodes: string[];
	nodeLabel: (node: string) => string;
	at: number | undefined;
	onSelect: (patch: SelectionPatch) => void;
}) {
	const locale = getLocale();
	const grid = resultGrid(result);
	const bucketMs =
		at === undefined ? latestBucket(result, grid) : bucketAt(result, at, grid);
	const parts = result.measures.map((measure) => {
		const part = measureResult(result, measure);
		return {
			measure,
			part,
			view: seriesView(
				part,
				DISPLAY,
				(node) => nodeLabel(node ?? ""),
				{},
				locale,
			),
		};
	});
	const views = new Map(parts.map((entry) => [entry.measure.name, entry.view]));
	return (
		<>
			{result.limited && (
				<p role="status" className="text-sm text-pretty text-muted-foreground">
					{m.execution_timeline_limited({ count: MAX_SERIES })}
				</p>
			)}
			<div className="grid gap-4 lg:grid-cols-2 min-[90rem]:grid-cols-3">
				{parts.map(({ measure, part, view }) => (
					<MeasurePanel
						key={measure.name}
						result={part}
						view={view}
						marker={bucketMs}
						onSelect={(bucket) => onSelect({ at: bucket })}
					/>
				))}
			</div>
			<InstantValues
				values={instantValues(result, nodes, bucketMs)}
				bucketMs={bucketMs}
				bucketSeconds={result.bucketSeconds ?? 60}
				first={grid[0] ?? bucketMs}
				last={grid.at(-1) ?? bucketMs}
				selected={at !== undefined}
				meta={{
					nodeLabel,
					format: (entry) =>
						views.get(entry.measure.name)?.format(entry.series ?? undefined)(
							entry.value,
						) ?? "—",
				}}
				onInstant={(next) => onSelect({ at: next })}
			/>
		</>
	);
}

function Body({
	measurements,
	...props
}: {
	measurements: UseQueryResult<QueryResult | null>;
	nodes: string[];
	nodeLabel: (node: string) => string;
	at: number | undefined;
	onSelect: (patch: SelectionPatch) => void;
}) {
	if (measurements.error)
		return (
			<FormFeedback
				kind="error"
				message={
					measurements.error instanceof MutationFailure
						? operationMessage(measurements.error.failure)
						: m.insight_unavailable()
				}
			/>
		);
	if (measurements.data === undefined)
		return (
			<div className="grid gap-4 lg:grid-cols-2 min-[90rem]:grid-cols-3">
				<Skeleton className="h-72" />
				<Skeleton className="h-72" />
				<Skeleton className="h-72" />
			</div>
		);
	if (measurements.data === null)
		return (
			<IconEmptyState
				icon={<ChartNoAxesColumnIcon aria-hidden="true" />}
				title={m.execution_timeline_no_measurements()}
				description={m.execution_timeline_no_measurements_hint()}
				heading="h3"
				className="bg-card"
			/>
		);
	return <Panels result={measurements.data} {...props} />;
}

/**
 * The CPU, memory and disk I/O of the execution's processes by machine, with exact
 * values at the selected instant.
 */
export function ExecutionMeasurements({
	measurements,
	nodes,
	nodeLabel,
	selectedNode,
	at,
	onSelect,
}: {
	measurements: UseQueryResult<QueryResult | null>;
	/** The machines whose values are listed: the selected one, or every member. */
	nodes: string[];
	nodeLabel: (node: string) => string;
	selectedNode: string | undefined;
	at: number | undefined;
	onSelect: (patch: SelectionPatch) => void;
}) {
	return (
		<section
			aria-labelledby="execution-measurements"
			aria-busy={measurements.isFetching}
			className="relative flex flex-col gap-4"
		>
			<LoadingBar active={measurements.isFetching && !!measurements.data} />
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2 id="execution-measurements" className="text-lg font-semibold">
						{m.execution_timeline_measurements()}
					</h2>
					<p className="text-sm font-medium">
						{selectedNode
							? m.execution_timeline_scope_node({
									node: nodeLabel(selectedNode),
								})
							: m.execution_timeline_scope_all()}
					</p>
				</div>
				{selectedNode && (
					<Button variant="outline" onClick={() => onSelect({ node: null })}>
						{m.execution_timeline_all_machines()}
					</Button>
				)}
			</div>
			<p className="max-w-3xl text-sm text-pretty text-muted-foreground">
				{m.execution_timeline_measurements_hint()}
			</p>
			<Body
				measurements={measurements}
				nodes={nodes}
				nodeLabel={nodeLabel}
				at={at}
				onSelect={onSelect}
			/>
		</section>
	);
}
