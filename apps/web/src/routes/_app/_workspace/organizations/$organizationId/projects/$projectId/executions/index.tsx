import { m } from "@pfe/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, PageHeading } from "@/components/workspace";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/",
)({ component: Executions });

function Executions() {
	return (
		<>
			<PageHeading title={m.executions()} />
			<EmptyState title={m.execution_data_is_not_connected_yet()}>
				<p className="max-w-xl text-sm text-muted-foreground">
					{m.no_execution_data_has_been_queried()}
				</p>
			</EmptyState>
		</>
	);
}
