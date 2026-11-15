import { createFileRoute } from "@tanstack/react-router";
import { listNodes } from "@/collectors/collector.functions";
import { NodesPage } from "@/collectors/nodes-page";
import { projectParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/nodes",
)({
	loader: async ({ params, location }) =>
		routeData(
			await listNodes({
				data: { ...projectParams(params), status: "active", page: 1 },
			}),
			location.href,
		),
	staleTime: 0,
	gcTime: 0,
	component: Nodes,
});

function Nodes() {
	const { user, project } = Route.useRouteContext();
	return (
		<NodesPage
			key={`${user.id}/${project.id}`}
			project={project}
			userId={user.id}
			initialNodes={Route.useLoaderData()}
		/>
	);
}
