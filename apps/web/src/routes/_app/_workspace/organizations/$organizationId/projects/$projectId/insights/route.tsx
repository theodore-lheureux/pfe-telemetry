import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/projects/$projectId/insights",
)({ component: Outlet });
