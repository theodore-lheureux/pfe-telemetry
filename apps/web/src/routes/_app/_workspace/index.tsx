import { m } from "@recount/i18n/messages";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/workspace";

export const Route = createFileRoute("/_app/_workspace/")({
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
		const organization = context.workspaceOrganization;
		if (organization)
			throw redirect({
				to: "/organizations/$organizationId",
				params: { organizationId: organization.id },
			});
	},
	head: () => ({
		meta: [{ title: `${m.create_organization()} · ${m.app_title()}` }],
	}),
	component: FirstOrganization,
});

function FirstOrganization() {
	return (
		<EmptyState title={m.create_your_first_organization()}>
			<p className="max-w-xl text-sm text-muted-foreground">
				{m.organizations_keep_your_teams_projects_together_create_one()}
			</p>
			<Button asChild>
				<Link to="/organizations/new">{m.create_organization()}</Link>
			</Button>
		</EmptyState>
	);
}
