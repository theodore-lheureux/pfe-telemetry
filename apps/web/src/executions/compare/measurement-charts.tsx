import { m } from "@recount/i18n/messages";
import { TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import type { MetricDefinition } from "../../analytics/contracts";
import { Skeleton } from "../../components/ui/skeleton";
import { IconEmptyState } from "../../components/workspace";
import { operationMessage } from "../../lib/operation-message";
import { MutationFailure } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import type { ExecutionDetail } from "../contracts";
import { executionPeriod } from "./context";
import { MeasurementCard } from "./measurement-card";
import {
	comparedMeasurement,
	comparisonInterval,
	comparisonQuery,
	plannedMeasurements,
} from "./measurements";
import { useComparisonQuery } from "./use-comparison-query";

/** CPU, memory and disk I/O of both executions, aligned on their elapsed time. */
export function MeasurementCharts({
	userId,
	reference,
	executions,
	catalog,
}: {
	userId: string;
	reference: ProjectReference;
	executions: [ExecutionDetail, ExecutionDetail];
	catalog: MetricDefinition[];
}) {
	const planned = useMemo(() => plannedMeasurements(catalog), [catalog]);
	const aligned = executions.map((execution) => {
		const period = executionPeriod(execution);
		return {
			key: execution.executionKey,
			durationMs: period.to.getTime() - period.from.getTime(),
		};
	});
	const interval = comparisonInterval(aligned.map((entry) => entry.durationMs));
	const query = comparisonQuery(
		planned,
		aligned.map((entry) => entry.key),
		interval,
	);
	const result = useComparisonQuery(userId, reference, query);
	const names: [string, string] = [executions[0].name, executions[1].name];
	return (
		<section
			aria-labelledby="execution-compare-measurements"
			aria-busy={result.isFetching}
			className="flex flex-col gap-3"
		>
			<div className="flex flex-col gap-1">
				<h2
					id="execution-compare-measurements"
					className="text-lg font-semibold text-balance"
				>
					{m.execution_compare_measurements()}
				</h2>
				<p className="max-w-3xl text-sm text-muted-foreground text-pretty">
					{m.execution_compare_alignment()}
				</p>
			</div>
			{result.isError ? (
				<IconEmptyState
					icon={<TriangleAlertIcon aria-hidden="true" />}
					title={m.insight_unavailable()}
					description={
						result.error instanceof MutationFailure
							? operationMessage(result.error.failure)
							: undefined
					}
					alert
					className="h-56 bg-card"
				/>
			) : (
				<div className="grid gap-4">
					{planned.map((entry) =>
						query && result.isPending && entry.definition ? (
							<Skeleton key={entry.name} className="h-96 w-full rounded-xl" />
						) : (
							<MeasurementCard
								key={entry.name}
								planned={entry}
								measurement={comparedMeasurement(
									result.data,
									entry.name,
									aligned,
								)}
								names={names}
								bucketSeconds={result.data?.bucketSeconds ?? 60}
							/>
						),
					)}
				</div>
			)}
		</section>
	);
}
