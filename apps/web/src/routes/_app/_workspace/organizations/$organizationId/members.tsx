import { m } from "@pfe/i18n/messages";
import { createFileRoute } from "@tanstack/react-router";
import { OrganizationInvitations } from "@/components/organization-invitations";
import { OrganizationMembers } from "@/components/organization-members";
import { listInvitations } from "@/organizations/invitation.functions";
import { listOrganizationMembers } from "@/organizations/member.functions";
import { organizationParams, routeData } from "@/organizations/route-data";

export const Route = createFileRoute(
	"/_app/_workspace/organizations/$organizationId/members",
)({
	loader: async ({ params, context, location }) => {
		const data = organizationParams(params);
		const [members, invitations] = await Promise.all([
			listOrganizationMembers({ data }),
			context.organization.role !== "member" ? listInvitations({ data }) : null,
		]);
		return {
			members: routeData(members, location.href),
			invitations: invitations ? routeData(invitations, location.href) : null,
			asOf: Date.now(),
		};
	},
	staleTime: 0,
	gcTime: 0,
	head: () => ({
		meta: [{ title: `${m.organization_members()} · ${m.app_title()}` }],
	}),
	component: Members,
});

function Members() {
	const { organization, user } = Route.useRouteContext();
	const { members, invitations, asOf } = Route.useLoaderData();
	return (
		<>
			<OrganizationMembers
				key={`members:${organization.id}:${user.id}`}
				organization={organization}
				members={members}
				userId={user.id}
			/>
			{invitations && (
				<OrganizationInvitations
					key={`invitations:${organization.id}:${user.id}`}
					organization={organization}
					invitations={invitations}
					asOf={asOf}
					userId={user.id}
				/>
			)}
		</>
	);
}
