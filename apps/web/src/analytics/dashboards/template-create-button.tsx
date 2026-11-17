import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { ProjectReference } from "../../organizations/contracts";
import type { TemplateValues } from "../dashboard-templates";
import { TemplateCreateDialog } from "./template-create-dialog";

export function TemplateCreateButton({
	userId,
	reference,
	templateId,
	name,
	values,
}: {
	userId: string;
	reference: ProjectReference;
	templateId: string;
	/** The new dashboard's suggested name, when not the template's own. */
	name?: string;
	values?: TemplateValues;
}) {
	const hydrated = useHydrated();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button disabled={!hydrated} onClick={() => setOpen(true)}>
				{m.dashboard_template_create_dashboard()}
			</Button>
			{open && (
				<TemplateCreateDialog
					open
					userId={userId}
					reference={reference}
					initialTemplateId={templateId}
					initialName={name}
					initialValues={values}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
