import { m } from "@recount/i18n/messages";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import {
	builtInDashboardTemplates,
	type CreateTemplateDashboardInput,
	type TemplateValues,
} from "../dashboard-templates";
import { createDashboardFromTemplate } from "../dashboard-templates.functions";
import { templatesQuery } from "../dashboard-templates-query";
import { saveDashboard } from "../dashboards.functions";
import { DashboardDialog } from "./dashboard-dialog";
import { TemplateGallery } from "./template-gallery";
import { TemplatePreview } from "./template-preview";
import { TemplateVariableField } from "./template-variable-field";

export function TemplateCreateDialog({
	open,
	userId,
	reference,
	initialTemplateId = "",
	initialName,
	initialValues = {},
	onClose,
}: {
	open: boolean;
	userId: string;
	reference: ProjectReference;
	initialTemplateId?: string;
	initialName?: string;
	initialValues?: TemplateValues;
	onClose: () => void;
}) {
	const [selected, setSelected] = useState(initialTemplateId);
	const [values, setValues] = useState(initialValues);
	const [dashboardId] = useState(() => crypto.randomUUID());
	const projects = useQuery({
		...templatesQuery(userId, reference),
		enabled: open,
	});
	const catalog = useAnalyticsCatalog(userId, reference, open);
	const choices = [...builtInDashboardTemplates(), ...(projects.data ?? [])];
	const choice = choices.find((item) => item.id === selected);
	const mutation = useAppMutation<
		CreateTemplateDashboardInput & { name: string; description: string },
		unknown
	>({
		userId,
		transientNotice: true,
		save: (data, signal) => {
			if (data.templateId) return createDashboardFromTemplate({ data, signal });
			return saveDashboard({ data, signal });
		},
	});
	const submit = async (value: { name: string; description: string }) => {
		const result = await mutation.submit({
			...reference,
			dashboardId,
			templateId: selected,
			values: Object.fromEntries(
				(choice?.template.variables ?? []).map(({ name }) => [
					name,
					values[name] ?? null,
				]),
			),
			...value,
		});
		if (!result || result.error) return;
		if (
			await result.refresh(async (go) => {
				await go({
					to: "/organizations/$organizationId/projects/$projectId/dashboards/$dashboardId",
					params: { ...reference, dashboardId },
				});
			})
		)
			onClose();
	};
	const failed = projects.isError || catalog.isError;
	const initial = choice?.template ?? { name: "", description: "" };
	const named =
		initialName && selected === initialTemplateId
			? { ...initial, name: initialName }
			: initial;
	return (
		<DashboardDialog
			wide
			open={open}
			title={m.dashboard_new()}
			initial={named}
			pending={mutation.pending}
			submitDisabled={mutation.disabled}
			error={mutation.kind === "success" ? "" : mutation.message}
			onClose={onClose}
			onSubmit={(value) => void submit(value)}
		>
			<TemplateGallery
				choices={choices}
				selected={selected}
				metrics={catalog.data?.metrics}
				disabled={mutation.disabled}
				onSelect={(next) => {
					setSelected(next);
					setValues(initialValues);
					mutation.clearMessage();
				}}
			/>
			{!projects.isError && !projects.data?.length && (
				<p className="text-sm text-muted-foreground">
					{projects.isPending
						? m.dashboard_templates_project_loading()
						: m.dashboard_templates_project_empty()}
				</p>
			)}
			{failed && (
				<div role="alert" className="flex items-center gap-2 text-sm">
					{m.dashboard_templates_load_error()}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							void projects.refetch();
							void catalog.refetch();
						}}
					>
						{m.try_again()}
					</Button>
				</div>
			)}
			{choice && (
				<TemplatePreview
					template={choice.template}
					metrics={catalog.data?.metrics}
				/>
			)}
			{choice?.template.variables?.map((variable) => (
				<TemplateVariableField
					key={variable.name}
					variable={variable}
					value={values[variable.name]}
					nodes={catalog.data?.nodes}
					disabled={mutation.disabled}
					onChange={(value) =>
						setValues((current) => ({ ...current, [variable.name]: value }))
					}
				/>
			))}
		</DashboardDialog>
	);
}
