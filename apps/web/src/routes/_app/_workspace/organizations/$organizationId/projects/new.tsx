import { m } from "@recount/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { CreateEntityForm } from "@/components/entity-form";
import { PageHeading } from "@/components/workspace";
import { createProject } from "@/organizations/organization.functions";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/new",
)({
	head: () => ({
		meta: [{ title: `${m.create_project()} · ${m.app_title()}` }],
	}),
	component: NewProject,
});
function NewProject() {
	const { organization } = Route.useRouteContext();
	if (organization.role === "member")
		return (
			<PageHeading title={m.administrator_access_required()}>
				{m.only_organization_owners_and_admins_can_create_projects()}
			</PageHeading>
		);
	return (
		<>
			<PageHeading title={m.create_project()}>
				{m.project_organization_help({ organization: organization.name })}
			</PageHeading>
			<CreateEntityForm
				key={organization.id}
				receiptBacked
				submitLabel={m.create_project()}
				save={(input, signal) =>
					createProject({
						signal,
						data: { ...input, organizationId: organization.id },
					})
				}
				onSuccess={async (project, navigate) => {
					const destination = {
						to: "/organizations/$organizationId/projects/$projectId/executions",
						params: { organizationId: organization.id, projectId: project.id },
					} as const;
					await navigate(destination);
				}}
			/>
		</>
	);
}
