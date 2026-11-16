import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { TimeDisplay } from "@/components/time-display";
import { PageHeading } from "@/components/workspace";
import { getExecution } from "@/executions/execution.functions";
import { ExecutionParticipants } from "@/executions/execution-participants";
import { parseExecutionReference } from "@/executions/validation";
import { routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/$executionKey",
)({
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
	component: Execution,
});

function Execution() {
	const { entry } = Route.useLoaderData();
	return (
		<>
			<PageHeading title={entry.name}>
				{m.execution_key()}: <code>{entry.executionKey}</code>
			</PageHeading>
			{entry.workloadVersion && (
				<p>
					{m.execution_workload_version()}: {entry.workloadVersion}
				</p>
			)}
			{Object.entries(entry.parameters).length > 0 && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
					{Object.entries(entry.parameters).map(([key, value]) => (
						<div key={key} className="contents">
							<dt>
								<code>{key}</code>
							</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>
			)}
			<p>
				{m.execution_node_count()}:{" "}
				{new Intl.NumberFormat(getLocale()).format(entry.nodeCount)}
			</p>
			<p>
				{m.execution_participant_count()}:{" "}
				{new Intl.NumberFormat(getLocale()).format(entry.participantCount)}
			</p>
			<p>
				{m.execution_environment_variables()}:{" "}
				{entry.environmentVariables.map((name) => (
					<code key={name} className="mr-2">
						{name}
					</code>
				))}
			</p>
			<p>
				{m.execution_first_seen()}: <TimeDisplay value={entry.firstSeen} />
			</p>
			<p>
				{m.execution_last_seen()}: <TimeDisplay value={entry.lastSeen} />
			</p>
			<ExecutionParticipants facts={entry.facts} />
		</>
	);
}
