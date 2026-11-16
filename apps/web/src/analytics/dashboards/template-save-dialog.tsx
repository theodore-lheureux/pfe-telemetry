import { m } from "@recount/i18n/messages";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import type { SaveDashboardTemplateInput } from "../dashboard-templates";
import { saveDashboardTemplate } from "../dashboard-templates.functions";
import { templatesQuery } from "../dashboard-templates-query";
import { DashboardDialog } from "./dashboard-dialog";

export function TemplateSaveDialog({
	userId,
	reference,
	dashboard,
	onClose,
}: {
	userId: string;
	reference: ProjectReference;
	dashboard: { id: string; name: string; description: string };
	onClose: () => void;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const [templateId] = useState(() => crypto.randomUUID());
	const [parameterizeNode, setParameterizeNode] = useState(false);
	const mutation = useAppMutation<SaveDashboardTemplateInput, unknown>({
		userId,
		saved: m.dashboard_templates_saved(),
		transientNotice: true,
		save: (data, signal) => saveDashboardTemplate({ data, signal }),
	});
	const submit = async (value: { name: string; description: string }) => {
		const result = await mutation.submit({
			...reference,
			dashboardId: dashboard.id,
			templateId,
			parameterizeNode,
			...value,
		});
		if (!result || result.error) return;
		if (
			await result.refresh(async () => {
				await queryClient.invalidateQueries({
					queryKey: templatesQuery(userId, reference).queryKey,
				});
			})
		)
			onClose();
	};
	return (
		<DashboardDialog
			open
			title={m.dashboard_templates_save_as()}
			initial={dashboard}
			pending={mutation.pending}
			submitDisabled={mutation.disabled}
			error={mutation.kind === "success" ? "" : mutation.message}
			onClose={onClose}
			onSubmit={(value) => void submit(value)}
		>
			<p className="text-sm text-muted-foreground">
				{m.dashboard_templates_snapshot_description()}
			</p>
			<div className="flex items-start gap-2">
				<Checkbox
					id={id}
					checked={parameterizeNode}
					disabled={mutation.disabled}
					onCheckedChange={(checked) => setParameterizeNode(checked === true)}
				/>
				<Label htmlFor={id}>{m.dashboard_templates_parameterize_node()}</Label>
			</div>
		</DashboardDialog>
	);
}
