import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { FormFeedback } from "../../components/form-feedback";
import { Skeleton } from "../../components/ui/skeleton";
import { operationMessage } from "../../lib/operation-message";
import { MutationFailure } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import {
	nodeHealthTemplate,
	previewDashboard,
	templateCoverage,
} from "../dashboard-templates";
import { DashboardPage } from "./dashboard-page";
import { TemplateCreateButton } from "./template-create-button";

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
	const catalog = useAnalyticsCatalog(userId, reference, useHydrated());
	if (catalog.error)
		return (
			<FormFeedback
				kind="error"
				message={
					catalog.error instanceof MutationFailure
						? operationMessage(catalog.error.failure)
						: m.insight_unavailable()
				}
			/>
		);
	if (!catalog.data) return <Skeleton className="h-96 w-full" />;
	const template = nodeHealthTemplate();
	const dashboard = previewDashboard(
		template,
		`${reference.projectId}/node-health`,
	);
	const coverage = templateCoverage(template, catalog.data.metrics);
	return (
		<DashboardPage
			userId={userId}
			reference={reference}
			canWrite={false}
			dashboard={{ ...dashboard, nodes: catalog.data.nodes }}
			urlFilters={urlFilters}
			onFilters={onFilters}
			preview={{
				unavailable: dashboard.tiles
					.filter((_, index) => !coverage.available[index])
					.map((tile) => tile.id),
				notice: (
					<p className="text-sm text-muted-foreground">
						{m.dashboard_template_preview_notice()}{" "}
						{m.dashboard_template_coverage(coverage)}
					</p>
				),
				actions: canWrite && (
					<TemplateCreateButton
						userId={userId}
						reference={reference}
						templateId="node-health"
					/>
				),
			}}
		/>
	);
}
