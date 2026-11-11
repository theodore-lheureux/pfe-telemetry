import { m } from "@recount/i18n/messages";
import {
	acceptInvitation,
	rejectInvitation,
} from "../../organizations/invitation.functions";
import { useAppMutation } from "../use-app-mutation";
import { usePageConfirmation } from "../use-page-confirmation";

export function useInvitationResponse(invitationId: string, userId: string) {
	const [confirmation, setConfirmation] = usePageConfirmation<boolean>();
	const mutation = useAppMutation<boolean, { organizationId: string } | null>({
		userId,
		save: async (accept, signal) => {
			if (accept) return acceptInvitation({ data: { invitationId }, signal });
			const result = await rejectInvitation({ data: { invitationId }, signal });
			return result.error ? result : { data: null, error: null };
		},
		saved: (accept) =>
			accept ? m.invitation_accepted() : m.your_invitation_was_rejected(),
		refreshFailed: m.your_invitation_response_was_saved_but_the_page(),
		unknown: m.the_invitation_request_did_not_complete_reload_to(),
	});
	const acceptedOrganization = mutation.data?.organizationId ?? null;
	const rejected = mutation.data === null;
	async function decide(accept: boolean) {
		if (rejected || acceptedOrganization) return;
		const saved = await mutation.submit(accept);
		if (!saved || saved.error) return;
		setConfirmation(null);
		await saved.refresh(
			async (navigate) => {
				if (saved.data)
					await navigate({
						to: "/organizations/$organizationId",
						params: { organizationId: saved.data.organizationId },
						replace: true,
					});
			},
			accept ? m.invitation_accepted() : m.your_invitation_was_rejected(),
		);
	}
	return {
		pending: mutation.pending,
		disabled: mutation.disabled,
		message: mutation.kind === "success" ? "" : mutation.message,
		kind: mutation.kind,
		rejected,
		acceptedOrganization,
		confirmReject: !!confirmation,
		setConfirmReject: (open: boolean) => setConfirmation(open ? true : null),
		decide,
		requestRejection() {
			mutation.clearMessage();
			setConfirmation(true);
		},
	};
}
