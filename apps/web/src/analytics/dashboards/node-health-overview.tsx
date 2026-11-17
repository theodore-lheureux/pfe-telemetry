import { m } from "@recount/i18n/messages";
import type { ProjectReference } from "../../organizations/contracts";
import { nodeHealthTemplate } from "../dashboard-templates";
import { TemplateDashboard } from "./template-dashboard";

export function NodeHealthOverview({
	userId,
	reference,
	canWrite,
	urlFilters,
	onFilters,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	urlFilters: string | undefined;
	onFilters: (filters: string | undefined) => void;
}) {
	return (
		<TemplateDashboard
			userId={userId}
			reference={reference}
			canWrite={canWrite}
			urlFilters={urlFilters}
			onFilters={onFilters}
			id={`${reference.projectId}/node-health`}
			templateId="node-health"
			template={nodeHealthTemplate()}
			notice={m.dashboard_template_preview_notice()}
		/>
	);
}
