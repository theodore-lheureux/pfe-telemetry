import { m } from "@recount/i18n/messages";
import { ArrowRightIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../../organizations/contracts";
import { Button } from "../ui/button";
import { PageHeading } from "../workspace";
import { SettingsSection } from "./settings-section";

export function OrganizationDeletion({
	organization,
}: {
	organization: OrganizationSummary;
}) {
	return (
		<div className="flex flex-col gap-8">
			<PageHeading
				title={m.settings_page({ page: m.settings_delete_organization() })}
			/>
			<SettingsSection
				id="delete-organization"
				title={m.settings_delete_organization()}
				description={m.settings_delete_org_description()}
			>
				<p
					id="delete-organization-unavailable"
					className="max-w-2xl text-sm text-muted-foreground"
				>
					{m.settings_deletion_unavailable()}
				</p>
				<a
					className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
					href="https://linear.app/pfe-telemetry/issue/PFE-72/add-safe-organization-and-project-deletion-across-application-data"
					target="_blank"
					rel="noopener noreferrer"
				>
					{m.settings_view_ticket({ ticket: "PFE-72" })}
					<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
				</a>
				<div>
					<Button
						variant="destructive"
						disabled
						aria-describedby="delete-organization-unavailable"
					>
						<Trash2Icon aria-hidden="true" />
						{m.settings_action_named({
							action: m.settings_delete_organization(),
							name: organization.name,
						})}
					</Button>
				</div>
			</SettingsSection>
		</div>
	);
}

export function ProjectDangerZone({ project }: { project: ProjectSummary }) {
	return (
		<div className="flex flex-col gap-8">
			<PageHeading
				title={m.settings_page({ page: m.settings_danger_zone() })}
			/>
			<SettingsSection
				id="move-project"
				title={m.settings_move_project()}
				description={m.settings_move_project_description()}
			>
				<p
					id="move-project-unavailable"
					className="max-w-2xl text-sm text-muted-foreground"
				>
					{m.settings_move_unavailable()}
				</p>
				<div>
					<Button
						variant="outline"
						disabled
						aria-describedby="move-project-unavailable"
					>
						<ArrowRightIcon aria-hidden="true" />
						{m.settings_action_named({
							action: m.settings_move_project(),
							name: project.name,
						})}
					</Button>
				</div>
			</SettingsSection>
			<SettingsSection
				id="delete-project"
				title={m.settings_delete_project()}
				description={m.settings_delete_project_description()}
			>
				<p
					id="delete-project-unavailable"
					className="max-w-2xl text-sm text-muted-foreground"
				>
					{m.settings_deletion_unavailable()}
				</p>
				<div>
					<Button
						variant="destructive"
						disabled
						aria-describedby="delete-project-unavailable"
					>
						<Trash2Icon aria-hidden="true" />
						{m.settings_action_named({
							action: m.settings_delete_project(),
							name: project.name,
						})}
					</Button>
				</div>
			</SettingsSection>
		</div>
	);
}
