import { m } from "@recount/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { ProjectReference } from "../../organizations/contracts";
import { TemplateCreateDialog } from "./template-create-dialog";

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
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
