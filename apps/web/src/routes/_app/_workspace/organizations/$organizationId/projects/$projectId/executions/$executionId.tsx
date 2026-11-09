import { formatDate } from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { EntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import {
	getExecution,
	queryExecutionTelemetry,
	updateExecution,
} from "@/executions/execution.functions";
import { RangeForm } from "@/executions/range-form";
import { ResourceCharts } from "@/executions/resource-charts";
import { parseExecutionReference } from "@/executions/validation";
import { operationMessage } from "@/lib/operation-message";
import { routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/$executionId",
)({
	validateSearch: (
		search: Record<string, unknown>,
	): { from?: string; to?: string } => ({
		from: typeof search.from === "string" ? search.from : undefined,
		to: typeof search.to === "string" ? search.to : undefined,
	}),
	loaderDeps: ({ search }) => search,
	loader: async ({ params, deps, location, abortController }) => {
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
		const telemetry = await queryExecutionTelemetry({
			data: { ...reference, ...deps },
			signal: abortController.signal,
		});
		if (
			telemetry.error &&
			["UNAUTHENTICATED", "NOT_FOUND", "FORBIDDEN"].includes(
				telemetry.error.code,
			)
		)
			routeData(telemetry, location.href);
		return { entry, telemetry };
	},
	staleTime: 0,
	gcTime: 0,
	component: Execution,
});

function Execution() {
	const { entry, telemetry } = Route.useLoaderData();
	const from = telemetry.data?.from ?? entry.startedAt;
	const to =
		telemetry.data?.to ??
		new Date(Math.min(entry.endedAt.getTime(), from.getTime() + 300000));
	return (
		<>
			<PageHeading title={entry.name}>
				{m.context_source_host({
					source: entry.sourceId,
					host: entry.hostId ?? m.all_source_hosts(),
				})}
			</PageHeading>
			<p>
				{m.recorded_interval({
					from: formatDate(entry.startedAt),
					to: formatDate(entry.endedAt),
				})}
			</p>
			{entry.canEdit && (
				<EntityForm
					name={entry.name}
					submitLabel={m.save_name()}
					save={({ name }) => updateExecution({ data: { ...entry, name } })}
					onSuccess={async () => {}}
				/>
			)}
			<h2 className="text-lg font-semibold">
				{m.node_context_during_this_execution()}
			</h2>
			<RangeForm
				key={`${entry.executionId}/${from.toISOString()}/${to.toISOString()}`}
				reference={entry}
				from={from}
				to={to}
			/>
			{telemetry.error ? (
				<div role="alert">
					<h3>{m.node_context_unavailable()}</h3>
					<p>{operationMessage(telemetry.error)}</p>
				</div>
			) : (
				<ResourceCharts result={telemetry.data} />
			)}
		</>
	);
}
