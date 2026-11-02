import { m } from "@pfe/i18n/messages";
import type { OrganizationSummary } from "../organizations/contracts";
import { InvitationForm } from "./member-administration/invitation-form";
import { InvitationList } from "./member-administration/invitation-list";
import {
	type Invitation,
	useOrganizationInvitations,
} from "./member-administration/use-organization-invitations";

export function OrganizationInvitations({
	organization,
	invitations,
	asOf,
	userId,
}: {
	organization: OrganizationSummary;
	invitations: Invitation[];
	asOf: number;
	userId: string;
}) {
	const state = useOrganizationInvitations(organization, userId);
	return (
		<section
			aria-labelledby="invitations-heading"
			aria-busy={state.pending}
			className="flex flex-col gap-4"
		>
			<h2
				ref={state.heading}
				tabIndex={-1}
				id="invitations-heading"
				className="text-xl font-semibold"
			>
				{m.invitations()}
			</h2>
			<InvitationForm state={state} organizationRole={organization.role} />
			<p role={state.failed ? "alert" : "status"} className="text-sm">
				{state.message}
			</p>
			<InvitationList
				state={state}
				invitations={invitations}
				asOf={asOf}
				organizationRole={organization.role}
			/>
		</section>
	);
}
