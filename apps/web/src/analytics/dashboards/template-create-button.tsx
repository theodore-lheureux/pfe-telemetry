import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useState } from "react";
import { FormFeedback } from "../../components/form-feedback";
import { Button } from "../../components/ui/button";
import { useAppMutation } from "../../components/use-app-mutation";
import type { ProjectReference } from "../../organizations/contracts";
import { createDashboardFromTemplate } from "../dashboard-templates.functions";

export function TemplateCreateButton({
	userId,
	reference,
	templateId,
}: {
	userId: string;
	reference: ProjectReference;
	templateId: string;
}) {
	const hydrated = useHydrated();
	const [dashboardId, setDashboardId] = useState<string>();
	const mutation = useAppMutation<string, unknown>({
		userId,
		transientNotice: true,
		save: (id, signal) =>
			createDashboardFromTemplate({
				data: { ...reference, templateId, dashboardId: id },
				signal,
			}),
	});
	const create = async () => {
		const id = dashboardId ?? crypto.randomUUID();
		setDashboardId(id);
		const result = await mutation.submit(id);
		if (!result || result.error) return;
		await result.refresh(async (go) => {
			await go({
				to: "/organizations/$organizationId/projects/$projectId/dashboards/$dashboardId",
				params: { ...reference, dashboardId: id },
			});
		});
	};
	return (
		<div className="flex flex-col items-start gap-2">
			<Button
				disabled={!hydrated || mutation.disabled}
				pending={mutation.pending}
				onClick={() => void create()}
			>
				{m.dashboard_template_create_dashboard()}
			</Button>
			<FormFeedback
				message={mutation.kind === "success" ? "" : mutation.message}
				kind="error"
				reserveLine={false}
			/>
		</div>
	);
}
