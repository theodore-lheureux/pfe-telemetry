import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FormFeedback } from "../../components/form-feedback";
import { Skeleton } from "../../components/ui/skeleton";
import { operationMessage } from "../../lib/operation-message";
import { MutationFailure } from "../../lib/operation-result";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import {
	type DashboardTemplate,
	previewDashboard,
	type TemplateValues,
	templateCoverage,
} from "../dashboard-templates";
import { DashboardPage } from "./dashboard-page";
import { TemplateCreateButton } from "./template-create-button";

/**
 * A built-in template shown as a read-only dashboard without saving it. Members who can
 * write create a dashboard from it, with the same variable values.
 */
export function TemplateDashboard({
	userId,
	reference,
	canWrite,
	urlFilters,
	onFilters,
	id,
	templateId,
	template,
	values,
	notice,
	back,
}: {
	userId: string;
	reference: ProjectReference;
	canWrite: boolean;
	urlFilters: string | undefined;
	onFilters: (filters: string | undefined) => void;
	/** Identifies the view, such as for its refresh state. */
	id: string;
	templateId: string;
	/** The template as shown, with any variables already filled. */
	template: DashboardTemplate;
	values?: TemplateValues;
	notice: string;
	back?: ReactNode;
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
	const dashboard = previewDashboard(template, id);
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
					<p className="text-sm text-pretty text-muted-foreground">
						{notice} {m.dashboard_template_coverage(coverage)}
					</p>
				),
				actions: canWrite && (
					<TemplateCreateButton
						userId={userId}
						reference={reference}
						templateId={templateId}
						name={template.name}
						values={values}
					/>
				),
				back,
			}}
		/>
	);
}
