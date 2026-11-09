import { m } from "@recount/i18n/messages";
import {
	createFileRoute,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { navClass, ProjectSwitcher } from "@/components/workspace";
import {
	getOrganization,
	listProjects,
} from "@/organizations/organization.functions";
import { organizationParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId",
)({
	beforeLoad: async ({ params, location }) => {
		const data = organizationParams(params);
		const [organization, projects] = await Promise.all([
			getOrganization({ data }),
			listProjects({ data }),
		]);
		return {
			organization: routeData(organization, location.href),
			projects: routeData(projects, location.href),
		};
	},
	staleTime: 0,
	gcTime: 0,
	component: Organization,
});
function Organization() {
	const { organization, projects } = Route.useRouteContext();
	const { projectId } = useParams({ strict: false });
	const params = { organizationId: organization.id };
	return (
		<>
			<div className="flex flex-wrap items-end justify-between gap-4 border-b pb-4">
				<ProjectSwitcher
					key={`${organization.id}/${projectId ?? "all"}`}
					projects={projects}
					organizationId={organization.id}
					projectId={projectId}
				/>
				<nav aria-label={m.organization()} className="flex flex-wrap gap-1">
					<Link
						to="/organizations/$organizationId"
						params={params}
						activeOptions={{ exact: true }}
						className={navClass}
					>
						{m.projects()}
					</Link>
					<Link
						to="/organizations/$organizationId/settings"
						params={params}
						className={navClass}
					>
						{m.organization_settings()}
					</Link>
					<Link
						to="/organizations/$organizationId/members"
						params={params}
						className={navClass}
					>
						{m.members()}
					</Link>
				</nav>
			</div>
			<Outlet />
		</>
	);
}
