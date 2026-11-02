import { m } from "@pfe/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectGrants } from "@/components/project-grants";
import { listProjectGrantCandidates } from "@/organizations/member.functions";
import { listProjectMembers } from "@/organizations/organization.functions";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/settings/members",
)({
	loader: async ({ params, location }) => {
		const data = projectParams(params);
		// Authorize project administration before loading the organization directory.
		const grants = routeData(await listProjectMembers({ data }), location.href);
		const members = routeData(
			await listProjectGrantCandidates({ data }),
			location.href,
		);
		return { grants, members };
	},
	staleTime: 0,
	gcTime: 0,
	head: () => ({
		meta: [{ title: `${m.project_access()} · ${m.app_title()}` }],
	}),
	component: Grants,
});

function Grants() {
	const { project, user } = Route.useRouteContext();
	const { grants, members } = Route.useLoaderData();
	return (
		<ProjectGrants
			key={`${project.id}:${user.id}`}
			project={project}
			members={members}
			grants={grants}
			userId={user.id}
		/>
	);
}
