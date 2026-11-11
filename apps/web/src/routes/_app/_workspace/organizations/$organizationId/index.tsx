import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeading } from "@/components/workspace";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/",
)({
	beforeLoad: ({ context }) => {
		const project = context.workspaceProject;
		if (project)
			throw redirect({
				to: "/organizations/$organizationId/projects/$projectId/executions",
				params: {
					organizationId: project.organizationId,
					projectId: project.id,
				},
			});
	},
	head: () => ({ meta: [{ title: `${m.projects()} · ${m.app_title()}` }] }),
	component: EmptyOrganization,
});
// Organizations with projects always open one; this page only serves empty organizations.
function EmptyOrganization() {
	const { organization } = Route.useRouteContext();
	const canCreate = organization.role !== "member";
	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-4">
				<PageHeading title={organization.name}>
					{m.projects_role({ role: roleLabel(organization.role) })}
				</PageHeading>
				{canCreate && (
					<Button asChild>
						<Link
							to="/organizations/$organizationId/projects/new"
							params={{ organizationId: organization.id }}
						>
							{m.create_project()}
						</Link>
					</Button>
				)}
			</div>
			<EmptyState title={m.no_visible_projects()}>
				<p className="text-sm text-muted-foreground">
					{canCreate
						? m.create_a_private_project_to_organize_your_executions()
						: m.ask_an_organization_administrator_to_give_you_access()}
				</p>
			</EmptyState>
		</>
	);
}
