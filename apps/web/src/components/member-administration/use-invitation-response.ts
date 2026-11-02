import { m } from "@pfe/i18n/messages";
import { useHydrated } from "@tanstack/react-router";
import { useState } from "react";
import { operationMessage } from "../../lib/operation-message";
import {
	acceptInvitation,
	rejectInvitation,
} from "../../organizations/invitation.functions";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useAdministrationOperation } from "./use-administration-operation";

export function useInvitationResponse(invitationId: string, userId: string) {
	const hydrated = useHydrated();
	const { router, begin } = useAdministrationOperation(userId);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [rejected, setRejected] = useState(false);
	const [confirmReject, setConfirmReject] = useState(false);
	const [acceptedOrganization, setAcceptedOrganization] = useState<
		string | null
	>(null);
	useLocaleChangeBlocker(pending);

	async function decide(accept: boolean) {
		if (!hydrated || rejected || acceptedOrganization) return;
		const operation = begin(() => {
			setPending(false);
			setConfirmReject(false);
		});
		if (!operation) return;
		let applied = false;
		setPending(true);
		setMessage("");
		try {
			if (accept) {
				const accepted = await acceptInvitation({ data: { invitationId } });
				if (!operation.current()) return;
				if (accepted.error) {
					setMessage(operationMessage(accepted.error));
					await router.invalidate({ sync: true });
					return;
				}
				applied = true;
				setAcceptedOrganization(accepted.data.organizationId);
				await router.navigate({
					to: "/organizations/$organizationId",
					params: { organizationId: accepted.data.organizationId },
					replace: true,
				});
			} else {
				const declined = await rejectInvitation({ data: { invitationId } });
				if (!operation.current()) return;
				if (declined.error) {
					setMessage(operationMessage(declined.error));
					await router.invalidate({ sync: true });
					return;
				}
				applied = true;
				setRejected(true);
				await operation.refresh(
					m.your_invitation_was_rejected(),
					m.your_invitation_was_rejected_but_the_page_could(),
				);
			}
		} catch {
			if (!operation.current()) return;
			setMessage(
				applied
					? m.your_invitation_response_was_saved_but_the_page()
					: m.the_invitation_request_did_not_complete_reload_to(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	return {
		pending,
		disabled: !hydrated || pending,
		message,
		rejected,
		confirmReject,
		setConfirmReject,
		acceptedOrganization,
		decide,
		requestRejection() {
			setMessage("");
			setConfirmReject(true);
		},
	};
}
