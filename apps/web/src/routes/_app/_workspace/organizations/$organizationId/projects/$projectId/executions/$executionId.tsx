import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/executions/$executionId",
)({
	loader: () => {
		throw notFound();
	},
});
