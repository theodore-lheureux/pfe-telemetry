import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeading } from "@/components/workspace";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/",
)({
	head: () => ({ meta: [{ title: `${m.projects()} · ${m.app_title()}` }] }),
	component: Projects,
});
function Projects() {
	const { organization, projects } = Route.useRouteContext();
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
			{projects.length ? (
				<ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{projects.map((project) => (
						<li key={project.id}>
							<Link
								to="/organizations/$organizationId/projects/$projectId/executions"
								params={{
									organizationId: organization.id,
									projectId: project.id,
								}}
								className="flex h-full flex-col gap-3 rounded-lg border bg-card p-5 text-card-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
							>
								<span className="font-semibold">{project.name}</span>
								{project.projectGroup && (
									<span className="text-sm text-muted-foreground">
										{project.projectGroup}
									</span>
								)}
								{project.tags.length > 0 && (
									<span className="flex flex-wrap gap-1">
										{project.tags.map((tag) => (
											<Badge key={tag} variant="outline">
												{tag}
											</Badge>
										))}
									</span>
								)}
								<span className="text-sm text-muted-foreground">
									{project.slug} · {roleLabel(project.role)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			) : (
				<EmptyState title={m.no_visible_projects()}>
					<p className="text-sm text-muted-foreground">
						{canCreate
							? m.create_a_private_project_to_organize_your_executions()
							: m.ask_an_organization_administrator_to_give_you_access()}
					</p>
				</EmptyState>
			)}
		</>
	);
}
