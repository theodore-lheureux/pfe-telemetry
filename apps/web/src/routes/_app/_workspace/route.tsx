import { createFileRoute, Outlet } from "@tanstack/react-router";
import { listOrganizations } from "@/organizations/organization.functions";
import { routeData } from "@/organizations/route-data";

export const Route = createFileRoute("/_app/_workspace")({
	beforeLoad: async ({ location }) => ({
		organizations: routeData(await listOrganizations(), location.href),
	}),
	staleTime: 0,
	gcTime: 0,
	component: Outlet,
});
