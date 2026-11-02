import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { OrganizationSwitcher } from "@/components/workspace";
import { listOrganizations } from "@/organizations/organization.functions";
import { routeData } from "@/organizations/route-data";

export const Route = createFileRoute("/_app/_workspace")({
	beforeLoad: async ({ location }) => ({
		organizations: routeData(await listOrganizations(), location.href),
	}),
	staleTime: 0,
	gcTime: 0,
	component: Workspace,
});

function Workspace() {
	const { organizations } = Route.useRouteContext();
	const { organizationId } = useParams({ strict: false });
	return (
		<>
			<OrganizationSwitcher
				key={organizationId ?? "all"}
				organizations={organizations}
				organizationId={organizationId}
			/>
			<Outlet />
		</>
	);
}
