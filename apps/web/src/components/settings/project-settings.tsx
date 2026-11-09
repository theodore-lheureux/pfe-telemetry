import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "../../organizations/contracts";
import { updateProject } from "../../organizations/organization.functions";
import { EntityForm } from "../entity-form";
import { ProjectAvatar } from "../identity-avatar";
import { settingsSearch } from "../settings-links";
import { Button } from "../ui/button";
import { PageHeading } from "../workspace";
import { IdentifierField } from "./identifier-field";
import { SettingsSection } from "./settings-section";

export function ProjectSettings({ project }: { project: ProjectSummary }) {
	return (
		<div className="flex flex-col gap-8">
			<PageHeading title={m.settings_page({ page: m.settings_general() })} />
			<SettingsSection
				id="project-identifier"
				title={m.project_identifier()}
				description={m.settings_project_id_description()}
			>
				<div className="grid max-w-4xl gap-4 xl:grid-cols-2">
					<div className="flex flex-col gap-3 rounded-md border bg-card p-4">
						<h3 className="text-sm font-medium">{m.project_identifier()}</h3>
						<IdentifierField value={project.id} />
					</div>
					<div
						id="project-slug"
						className="flex flex-col gap-3 rounded-md border bg-card p-4"
					>
						<h3 className="text-sm font-medium">{m.slug()}</h3>
						<IdentifierField value={project.slug} />
					</div>
				</div>
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
								search={settingsSearch("credentials", {
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
			<PageHeading
				title={m.settings_page({ page: m.settings_customization() })}
			/>
			<SettingsSection
				id="project-details"
				title={m.settings_project_details()}
				description={m.settings_project_details_description()}
			>
				<h3 className="text-sm font-medium">{m.settings_name_logo()}</h3>
				<div className="flex items-start gap-6">
					<ProjectAvatar
						name={project.name}
						className="size-16 rounded-md text-xl"
					/>
					{project.role === "admin" ? (
						<EntityForm
							className="min-w-0 flex-1 border-0 bg-transparent p-0"
							name={project.name}
							requireChanged
							reserveFeedbackLine={false}
							submitLabel={m.save_project()}
							save={({ name }) =>
								updateProject({
									data: {
										organizationId: project.organizationId,
										projectId: project.id,
										name,
									},
								})
							}
							onSuccess={async () => {}}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							{m.you_have_read_access_ask_a_project_admin()}
						</p>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					{m.settings_logo_unavailable()}
				</p>
			</SettingsSection>
		</div>
	);
}
