import { m } from "@recount/i18n/messages";
import { UserPlusIcon } from "lucide-react";
import type { OrganizationSummary } from "../organizations/contracts";
import { FormFeedback } from "./form-feedback";
import { InvitationForm } from "./member-administration/invitation-form";
import { InvitationList } from "./member-administration/invitation-list";
import {
	type Invitation,
	useOrganizationInvitations,
} from "./member-administration/use-organization-invitations";
import { SettingsSection } from "./settings/settings-section";
import { Button } from "./ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./ui/collapsible";

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
		<SettingsSection
			id="invitations-heading"
			title={m.settings_pending_invites()}
			description={m.settings_invites_description()}
			headingRef={state.heading}
		>
			<FormFeedback
				message={state.cancelId ? "" : state.message}
				kind={state.failed ? "error" : "success"}
				pending={state.pending && !state.cancelId}
				pendingMessage={
					state.activity?.type === "resend"
						? m.resending_invitation()
						: m.sending_invitation()
				}
			/>
			<InvitationList
				state={state}
				invitations={invitations.filter(
					(invitation) => invitation.status === "pending",
				)}
				asOf={asOf}
				organizationRole={organization.role}
			/>
			<Collapsible>
				<CollapsibleTrigger asChild>
					<Button variant="outline" disabled={state.disabled}>
						<UserPlusIcon aria-hidden="true" />
						{m.settings_invite_member()}
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-4">
					<InvitationForm state={state} organizationRole={organization.role} />
				</CollapsibleContent>
			</Collapsible>
		</SettingsSection>
	);
}
