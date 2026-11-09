import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { navClass } from "@/components/workspace";
import { getProject } from "@/organizations/organization.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId",
)({
	beforeLoad: async ({ params, location }) => ({
		project: routeData(
			await getProject({ data: projectParams(params) }),
			location.href,
		),
	}),
	staleTime: 0,
	gcTime: 0,
	component: Project,
});
function Project() {
	const { project } = Route.useRouteContext();
	const params = {
		organizationId: project.organizationId,
		projectId: project.id,
	};
	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<p className="text-lg font-semibold">{project.name}</p>
					<p className="text-sm text-muted-foreground">
						{m.private_project_role({ role: roleLabel(project.role) })}
					</p>
				</div>
				<nav aria-label={m.project()} className="flex flex-wrap gap-1">
					<Link
						to="/organizations/$organizationId/projects/$projectId/executions"
						params={params}
						className={navClass}
					>
						{m.executions()}
					</Link>
					<Link
						to="/organizations/$organizationId/projects/$projectId/settings"
						params={params}
						className={navClass}
					>
						{m.project_settings()}
					</Link>
					{project.role === "admin" && (
						<Link
							to="/organizations/$organizationId/projects/$projectId/settings/members"
							params={params}
							className={navClass}
						>
							{m.project_members()}
						</Link>
					)}
					{project.role === "admin" && (
						<Link
							to="/organizations/$organizationId/projects/$projectId/settings/credentials"
							params={params}
							className={navClass}
						>
							{m.collector_credentials()}
						</Link>
					)}
				</nav>
			</div>
			<Outlet />
		</>
	);
}
