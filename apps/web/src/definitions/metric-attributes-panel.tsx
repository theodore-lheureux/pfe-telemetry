import { m } from "@recount/i18n/messages";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { IconEmptyState } from "../components/workspace";
import { operationMessage } from "../lib/operation-message";
import { MutationFailure, unwrapOperation } from "../lib/operation-result";
import type { ProjectReference } from "../organizations/contracts";
import { AttributeTable } from "./attribute-table";
import type { MetricEntry } from "./contracts";
import { listMetricAttributeDefinitions } from "./definitions.functions";

/** A metric's attributes with a recent value of each, loaded when its row opens. */
export function MetricAttributesPanel({
	userId,
	reference,
	metric,
}: {
	userId: string;
	reference: ProjectReference;
	metric: MetricEntry;
}) {
	const attributes = useQuery({
		queryKey: [
			"metric-definition-attributes",
			userId,
			reference.projectId,
			metric.name,
		],
		queryFn: async ({ signal }) =>
			unwrapOperation(
				await listMetricAttributeDefinitions({
					data: { ...reference, metric: metric.name },
					signal,
				}),
			),
		staleTime: 60_000,
		retry: false,
	});
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-semibold">
					{m.definitions_metric_attributes()}
				</h3>
				<Button asChild variant="outline" size="sm">
					<Link
						to="/organizations/$organizationId/projects/$projectId/definitions/metrics/$metric"
						params={{ ...reference, metric: metric.name }}
					>
						{m.definitions_view_definition()}
						<ArrowRightIcon aria-hidden="true" />
					</Link>
				</Button>
			</div>
			{attributes.isPending && <Skeleton className="h-24 w-full" />}
			{attributes.isError && (
				<IconEmptyState
					icon={<TriangleAlertIcon aria-hidden="true" />}
					title={m.definitions_attributes_unavailable()}
					description={
						attributes.error instanceof MutationFailure
							? operationMessage(attributes.error.failure)
							: undefined
					}
					alert
					heading="h3"
					className="bg-card py-6"
				>
					<Button
						variant="outline"
						size="sm"
						disabled={attributes.isFetching}
						onClick={() => void attributes.refetch()}
					>
						<RefreshCwIcon
							aria-hidden="true"
							className={
								attributes.isFetching ? "motion-safe:animate-spin" : ""
							}
						/>
						{m.activity_retry()}
					</Button>
				</IconEmptyState>
			)}
			{attributes.data && (
				<AttributeTable
					reference={reference}
					attributes={attributes.data}
					label={m.definitions_metric_attributes()}
					columns={{ metrics: false, lastSeen: false }}
				/>
			)}
		</div>
	);
}
