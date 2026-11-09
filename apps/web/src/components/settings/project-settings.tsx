import { m } from "@recount/i18n/messages";
import { EntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import type { ProjectSummary } from "@/organizations/contracts";
import { updateProject } from "@/organizations/organization.functions";

export function ProjectSettings({ project }: { project: ProjectSummary }) {
	return (
		<>
			<PageHeading title={m.project_settings()}>
				{m.only_effective_project_admins_can_change_this_project()}
			</PageHeading>
			<dl className="flex flex-col gap-2 text-sm">
				<div id="project-slug">
					<dt className="inline text-muted-foreground">{m.slug()}: </dt>
					<dd className="inline">{project.slug}</dd>
				</div>
				<div id="project-identifier">
					<dt className="inline text-muted-foreground">
						{m.project_identifier()}:{" "}
					</dt>
					<dd className="inline break-all font-mono text-xs">{project.id}</dd>
				</div>
			</dl>
			{project.role === "admin" ? (
				<EntityForm
					className="max-w-md border-0 bg-transparent p-0"
					key={project.id}
					name={project.name}
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
		</>
	);
}
