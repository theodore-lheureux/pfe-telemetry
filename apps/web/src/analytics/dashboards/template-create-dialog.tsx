import { m } from "@recount/i18n/messages";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { useAnalyticsCatalog } from "../catalog";
import type { CreateTemplateDashboardInput } from "../dashboard-templates";
import { createDashboardFromTemplate } from "../dashboard-templates.functions";
import { useTemplateChoices } from "../dashboard-templates-query";
import { saveDashboard } from "../dashboards.functions";
import { DashboardDialog } from "./dashboard-dialog";
import { TemplateGallery } from "./template-gallery";
import { TemplatePreview } from "./template-preview";

export function TemplateCreateDialog({
	open,
	userId,
	reference,
	initialTemplateId = "",
	onClose,
}: {
	open: boolean;
	userId: string;
	reference: ProjectReference;
	initialTemplateId?: string;
	onClose: () => void;
}) {
	const id = useId();
	const [selected, setSelected] = useState(initialTemplateId);
	const [node, setNode] = useState("-all");
	const [dashboardId] = useState(() => crypto.randomUUID());
	const { choices, projects } = useTemplateChoices(userId, reference, open);
	const catalog = useAnalyticsCatalog(userId, reference, open);
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
		const values = choice?.template.variables?.length
			? { $node: node === "-all" ? null : node }
			: {};
		const result = await mutation.submit({
			...reference,
			dashboardId,
			templateId: selected,
			values,
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
	return (
		<DashboardDialog
			wide
			open={open}
			title={m.dashboard_new()}
			initial={choice?.template ?? { name: "", description: "" }}
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
					setNode("-all");
					mutation.clearMessage();
				}}
			/>
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
				<div key={variable.name} className="flex flex-col gap-2">
					<Label htmlFor={`${id}-node`}>
						{m.dashboard_templates_node_variable()}
					</Label>
					<p className="text-xs text-muted-foreground">
						{m.dashboard_templates_node_variable_help()}
					</p>
					<Select
						value={node}
						disabled={mutation.disabled || !catalog.data}
						onValueChange={setNode}
					>
						<SelectTrigger id={`${id}-node`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="-all">
								{m.dashboard_templates_all_nodes()}
							</SelectItem>
							{catalog.data?.nodes.map((item) => (
								<SelectItem key={item.id} value={item.id}>
									{item.hostname || item.id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			))}
		</DashboardDialog>
	);
}
