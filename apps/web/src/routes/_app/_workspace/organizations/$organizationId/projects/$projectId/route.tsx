import { createFileRoute, Outlet } from "@tanstack/react-router";
import { developerCapability } from "@/developer/developer.functions";
import { DeveloperToolbar } from "@/developer/toolbar";
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
		developer:
			(await developerCapability({ data: projectParams(params) })).data ?? null,
	}),
	staleTime: 0,
	gcTime: 0,
	component: ProjectLayout,
});

function ProjectLayout() {
	const { user, developer, project } = Route.useRouteContext();
	return (
		<>
			<Outlet />
			<DeveloperToolbar
				key={`${user.id}:${project.id}`}
				userId={user.id}
				reference={{
					organizationId: project.organizationId,
					projectId: project.id,
				}}
				capability={developer}
			/>
		</>
	);
}
