import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { Card, CardContent } from "../../components/ui/card";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import {
	builtInDashboardTemplates,
	templateCoverage,
} from "../dashboard-templates";
import { TemplateCreateButton } from "./template-create-button";

export function TemplateSuggestions({
	userId,
	reference,
}: {
	userId: string;
	reference: ProjectReference;
}) {
	const catalog = useAnalyticsCatalog(userId, reference, useHydrated());
	if (!catalog.data) return null;
	const suggestions = builtInDashboardTemplates().filter(
		({ template }) =>
			templateCoverage(template, catalog.data.metrics).recommended,
	);
	if (!suggestions.length) return null;
	return (
		<section
			aria-label={m.dashboard_template_suggested_templates()}
			className="flex flex-col gap-3"
		>
			<h2 className="text-base font-semibold">
				{m.dashboard_template_suggested_templates()}
			</h2>
			{suggestions.map(({ id, template }) => (
				<Card key={id}>
					<CardContent className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h3 className="font-medium">{template.name}</h3>
							<p className="text-sm text-muted-foreground">
								{template.description}
							</p>
							<p className="text-sm text-muted-foreground">
								{m.dashboard_template_coverage(
									templateCoverage(template, catalog.data.metrics),
								)}
							</p>
						</div>
						<TemplateCreateButton
							userId={userId}
							reference={reference}
							templateId={id}
						/>
					</CardContent>
				</Card>
			))}
		</section>
	);
}
