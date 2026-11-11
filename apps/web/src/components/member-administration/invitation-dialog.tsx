import { m } from "@recount/i18n/messages";
import type { OrganizationSummary } from "../../organizations/contracts";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { InvitationForm } from "./invitation-form";
import { useOrganizationInvitations } from "./use-organization-invitations";

export function InvitationDialogContent({
	organization,
	state,
	onCancel,
}: {
	organization: OrganizationSummary;
	state: ReturnType<typeof useOrganizationInvitations>;
	onCancel?: () => void;
}) {
	return (
		<DialogContent
			className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
			showCloseButton={!state.formPending}
		>
			<DialogHeader className="shrink-0 border-b px-6 py-5 pr-12">
				<DialogTitle className="text-xl font-semibold">
					{m.invite_others_to({ organization: organization.name })}
				</DialogTitle>
				<DialogDescription className="leading-relaxed">
					{m.invite_organization_description()}
				</DialogDescription>
			</DialogHeader>
			<InvitationForm
				state={state}
				organizationRole={organization.role}
				onCancel={onCancel}
			/>
		</DialogContent>
	);
}

export function OrganizationInvitationPopup({
	organization,
	userId,
	onClose,
}: {
	organization: OrganizationSummary;
	userId: string;
	onClose: () => void;
}) {
	const state = useOrganizationInvitations(organization, userId, onClose);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !state.pending) onClose();
			}}
		>
			<InvitationDialogContent
				organization={organization}
				state={state}
				onCancel={onClose}
			/>
		</Dialog>
	);
}
