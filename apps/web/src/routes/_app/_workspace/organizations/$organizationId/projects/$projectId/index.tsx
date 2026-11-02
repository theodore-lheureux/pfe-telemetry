import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/",
)({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/organizations/$organizationId/projects/$projectId/executions",
			params,
			replace: true,
		});
	},
});
