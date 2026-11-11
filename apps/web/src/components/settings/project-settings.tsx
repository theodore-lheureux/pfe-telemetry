import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "../../organizations/contracts";
import { updateProject } from "../../organizations/organization.functions";
import { RenameEntityForm } from "../entity-form";
import { ProjectAvatar } from "../identity-avatar";
import { settingsSearch } from "../settings-links";
import { Button } from "../ui/button";
import { EntityIdentityRow } from "./entity-identity-row";
import { IdentifierCard } from "./identifier-field";
import { ProjectMetadata } from "./project-metadata";
import { SettingsPageHeading } from "./settings-page-heading";
import { SettingsSection } from "./settings-section";

export function ProjectSettings({ project }: { project: ProjectSummary }) {
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading />
			<SettingsSection
				id="project-identifier"
				title={m.project_identifier()}
				description={m.settings_project_id_description()}
			>
				<IdentifierCard value={project.id} />
			</SettingsSection>
			<SettingsSection
				id="collector-setup"
				title={m.collector_credentials()}
				description={m.settings_collector_setup_description()}
			>
				{project.role === "admin" && (
					<div>
						<Button asChild variant="outline">
							<Link
								to="/settings"
								search={settingsSearch("collectors", {
									organizationId: project.organizationId,
									projectId: project.id,
								})}
							>
								{m.settings_manage_credentials()}
							</Link>
						</Button>
					</div>
				)}
			</SettingsSection>
		</div>
	);
}

export function ProjectCustomization({ project }: { project: ProjectSummary }) {
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading />
			<SettingsSection
				id="project-details"
				title={m.settings_project_details()}
				description={m.settings_project_details_description()}
			>
				<h3 className="text-sm font-medium">{m.settings_name_logo()}</h3>
				<EntityIdentityRow
					avatar={
						<ProjectAvatar
							name={project.name}
							className="size-16 rounded-md text-xl"
						/>
					}
				>
					{project.role === "admin" ? (
						<RenameEntityForm
							labelHidden
							requireChanged
							className="border-0 bg-transparent p-0"
							name={project.name}
							reserveFeedbackLine={false}
							submitLabel={m.save_project()}
							save={({ name }, signal) =>
								updateProject({
									signal,
									data: {
										organizationId: project.organizationId,
										projectId: project.id,
										name,
									},
								})
							}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							{m.you_have_read_access_ask_a_project_admin()}
						</p>
					)}
				</EntityIdentityRow>
			</SettingsSection>
			<ProjectMetadata project={project} />
		</div>
	);
}
