import { m } from "@recount/i18n/messages";
import { PlusIcon } from "lucide-react";
import type { OrganizationSummary } from "../organizations/contracts";
import type { MemberSummary } from "../organizations/member-contracts";
import { FormFeedback } from "./form-feedback";
import { InvitationDialogContent } from "./member-administration/invitation-dialog";
import { InvitationList } from "./member-administration/invitation-list";
import {
	type Invitation,
	useOrganizationInvitations,
} from "./member-administration/use-organization-invitations";
import { SettingsSection } from "./settings/settings-section";
import { Button } from "./ui/button";
import { Dialog, DialogTrigger } from "./ui/dialog";

export function OrganizationInvitations({
	organization,
	invitations,
	asOf,
	userId,
	members,
}: {
	organization: OrganizationSummary;
	invitations: Invitation[];
	asOf: number;
	userId: string;
	members: MemberSummary[];
}) {
	const state = useOrganizationInvitations(organization, userId);
	return (
		<SettingsSection
			id="invitations-heading"
			title={m.settings_pending_invites()}
			description={m.settings_invites_description()}
			headingRef={state.heading}
			actions={
				<Dialog
					open={state.inviting}
					onOpenChange={(open) => {
						if (state.pending) return;
						if (open) state.openInvitationForm();
						else state.setInviting(null);
					}}
				>
					<DialogTrigger asChild>
						<Button variant="outline" disabled={state.disabled}>
							<PlusIcon aria-hidden="true" />
							{m.settings_invite_member()}
						</Button>
					</DialogTrigger>
					<InvitationDialogContent organization={organization} state={state} />
				</Dialog>
			}
		>
			{!state.inviting && (
				<FormFeedback
					reserveLine={false}
					message={state.cancelId ? "" : state.message}
					kind={state.failed ? "error" : "success"}
					pending={state.pending && !state.cancelId}
					pendingMessage={
						state.activity?.type === "resend"
							? m.resending_invitation()
							: m.sending_invitation()
					}
				/>
			)}
			<InvitationList
				state={state}
				invitations={invitations.filter(
					(invitation) => invitation.status === "pending",
				)}
				asOf={asOf}
				organizationRole={organization.role}
				members={members}
				userId={userId}
			/>
		</SettingsSection>
	);
}
