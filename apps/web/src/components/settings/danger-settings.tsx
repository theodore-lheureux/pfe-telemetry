import { m } from "@recount/i18n/messages";
import { ArrowRightIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { ComingSoonNotice } from "./coming-soon-notice";
import { SettingsPageHeading } from "./settings-page-heading";

const deletionTicket = {
	name: "PFE-72",
	url: "https://linear.app/pfe-telemetry/issue/PFE-72/add-safe-organization-and-project-deletion-across-application-data",
};

export function OrganizationDeletion() {
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading />
			<DangerZone>
				<DangerAction
					id="delete-organization"
					title={m.settings_delete_organization()}
					description={m.settings_delete_org_description()}
					unavailable={m.settings_deletion_unavailable()}
					ticket={deletionTicket}
					action={
						<Button
							variant="destructive"
							disabled
							aria-describedby="delete-organization-unavailable"
						>
							<Trash2Icon aria-hidden="true" />
							{m.settings_delete_organization()}
						</Button>
					}
				/>
			</DangerZone>
		</div>
	);
}

export function ProjectDangerZone() {
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading />
			<DangerZone>
				<DangerAction
					id="move-project"
					title={m.settings_move_project()}
					description={m.settings_move_project_description()}
					unavailable={m.settings_move_unavailable()}
					ticket={{
						name: "PFE-88",
						url: "https://linear.app/pfe-telemetry/issue/PFE-88/implement-safe-project-transfers-between-organizations",
					}}
					action={
						<Button
							variant="outline"
							disabled
							aria-describedby="move-project-unavailable"
						>
							<ArrowRightIcon aria-hidden="true" />
							{m.settings_move_project()}
						</Button>
					}
				/>
				<DangerAction
					id="delete-project"
					title={m.settings_delete_project()}
					description={m.settings_delete_project_description()}
					unavailable={m.settings_deletion_unavailable()}
					ticket={deletionTicket}
					action={
						<Button
							variant="destructive"
							disabled
							aria-describedby="delete-project-unavailable"
						>
							<Trash2Icon aria-hidden="true" />
							{m.settings_delete_project()}
						</Button>
					}
				/>
			</DangerZone>
		</div>
	);
}

function DangerZone({ children }: { children: ReactNode }) {
	return (
		<div className="max-w-2xl divide-y divide-destructive/20 rounded-lg border border-destructive/40">
			{children}
		</div>
	);
}

function DangerAction({
	id,
	title,
	description,
	unavailable,
	ticket,
	action,
}: {
	id: string;
	title: string;
	description: string;
	unavailable: string;
	ticket?: { name: string; url: string };
	action: ReactNode;
}) {
	return (
		<section
			aria-labelledby={id}
			className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
		>
			<div className="flex min-w-0 flex-col gap-2">
				<h2 id={id} className="scroll-mt-6 text-sm font-semibold">
					{title}
				</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
				<ComingSoonNotice id={`${id}-unavailable`} ticket={ticket}>
					{unavailable}
				</ComingSoonNotice>
			</div>
			<div className="shrink-0">{action}</div>
		</section>
	);
}
