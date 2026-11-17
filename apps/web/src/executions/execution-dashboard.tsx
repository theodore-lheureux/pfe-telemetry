import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import {
	executionContext,
	executionPeriod,
	executionTemplate,
	fillTemplateVariables,
	MAX_EXECUTION_NODES,
} from "../analytics/dashboard-templates";
import { TemplateDashboard } from "../analytics/dashboards/template-dashboard";
import { MAX_RANGE_DAYS } from "../analytics/insight/draft";
import { Button } from "../components/ui/button";
import type { ExecutionDetail } from "./contracts";

/**
 * The Execution template with `$execution` bound to one execution, over its period. It
 * is not saved; members who can write create a dashboard from it.
 */
export function ExecutionDashboard({
	userId,
	execution,
	canWrite,
	urlFilters,
	onFilters,
}: {
	userId: string;
	execution: ExecutionDetail;
	canWrite: boolean;
	urlFilters: string | undefined;
	onFilters: (filters: string | undefined) => void;
}) {
	const { organizationId, projectId, executionKey } = execution;
	const values = useMemo(() => ({ $execution: executionKey }), [executionKey]);
	const context = useMemo(() => executionContext(execution), [execution]);
	const template = useMemo(
		() => ({
			...fillTemplateVariables(executionTemplate(), values, context),
			name: execution.name,
		}),
		[context, execution.name, values],
	);
	const notices = [m.execution_dashboard_notice()];
	if (executionPeriod(context).clamped)
		notices.push(m.execution_dashboard_clamped({ days: MAX_RANGE_DAYS }));
	if (context.nodes.length > MAX_EXECUTION_NODES)
		notices.push(
			m.execution_dashboard_nodes_truncated({
				shown: MAX_EXECUTION_NODES,
				total: context.nodes.length,
			}),
		);
	return (
		<TemplateDashboard
			userId={userId}
			reference={{ organizationId, projectId }}
			canWrite={canWrite}
			urlFilters={urlFilters}
			onFilters={onFilters}
			id={`${projectId}/execution/${executionKey}`}
			templateId="execution"
			template={template}
			values={values}
			notice={notices.join(" ")}
			back={
				<Button asChild variant="ghost" size="icon-sm">
					<Link
						to="/organizations/$organizationId/projects/$projectId/executions/$executionKey"
						params={{ organizationId, projectId, executionKey }}
						aria-label={m.execution_dashboard_back()}
					>
						<ArrowLeftIcon aria-hidden="true" />
					</Link>
				</Button>
			}
		/>
	);
}
