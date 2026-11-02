import { m } from "@pfe/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { EntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import { updateProject } from "@/organizations/organization.functions";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/settings/",
)({
	head: () => ({
		meta: [{ title: `${m.project_settings()} · ${m.app_title()}` }],
	}),
	component: ProjectSettings,
});
function ProjectSettings() {
	const { project } = Route.useRouteContext();
	return (
		<>
			<PageHeading title={m.project_settings()}>
				{m.only_effective_project_admins_can_change_this_project()}
			</PageHeading>
			<dl className="flex flex-col gap-2 text-sm">
				<div>
					<dt className="inline text-muted-foreground">{m.slug()}: </dt>
					<dd className="inline">{project.slug}</dd>
				</div>
				<div>
					<dt className="inline text-muted-foreground">
						{m.project_identifier()}:{" "}
					</dt>
					<dd className="inline break-all font-mono text-xs">{project.id}</dd>
				</div>
			</dl>
			{project.role === "admin" ? (
				<EntityForm
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
