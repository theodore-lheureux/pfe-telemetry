import { m } from "@recount/i18n/messages";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getCurrentUser } from "@/auth/session.functions";
import { InvitationPage } from "@/components/member-administration/invitation-page";
import { parseIdentifier } from "@/lib/input";
import { inspectInvitation } from "@/organizations/invitation.functions";

export const Route = createFileRoute("/invitations/$invitationId")({
	beforeLoad: async ({ params, context }) => {
		await context.authentication.beforePrivateRead();
		const user = await getCurrentUser();
		if (!user)
			throw redirect({
				to: "/login",
				search: {
					redirect: `/invitations/${encodeURIComponent(params.invitationId)}`,
				},
			});
		return { user };
	},
	loader: ({ params }) => {
		try {
			parseIdentifier(params.invitationId);
		} catch {
			return {
				data: null,
				error: {
					code: "NOT_FOUND" as const,
					message: m.invitation_unavailable(),
				},
			};
		}
		return inspectInvitation({ data: { invitationId: params.invitationId } });
	},
	headers: () => ({ "Cache-Control": "private, no-store" }),
	staleTime: 0,
	gcTime: 0,
	head: () => ({
		meta: [{ title: `${m.organization_invitation()} · ${m.app_title()}` }],
	}),
	component: InvitationRoute,
});

function InvitationRoute() {
	const { user } = Route.useRouteContext();
	const { invitationId } = Route.useParams();
	const result = Route.useLoaderData();
	return (
		<InvitationPage
			key={`${invitationId}:${user.id}`}
			invitationId={invitationId}
			user={user}
			result={result}
		/>
	);
}
