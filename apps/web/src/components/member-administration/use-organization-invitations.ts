import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useHydrated } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { operationMessage } from "../../lib/operation-message";
import type {
	OrganizationRole,
	OrganizationSummary,
} from "../../organizations/contracts";
import {
	cancelInvitation,
	createInvitation,
} from "../../organizations/invitation.functions";
import { useAppForm } from "../app-form";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useMutationOwner } from "../use-mutation-owner";

export type Invitation = NonNullable<
	Awaited<ReturnType<typeof createInvitation>>["data"]
>;

export function useOrganizationInvitations(
	organization: OrganizationSummary,
	userId: string,
) {
	const hydrated = useHydrated();
	const { router, begin } = useMutationOwner(userId);
	const heading = useRef<HTMLHeadingElement>(null);
	const [actionPending, setPending] = useState(false);
	const values: { email: string; role: OrganizationRole } = {
		email: "",
		role: "member",
	};
	const form = useAppForm({
		defaultValues: values,
		onSubmit: async ({ value }) => send(value),
	});
	const sending = useSelector(form.store, (state) => state.isSubmitting);
	const pending = actionPending || sending;
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [cancelId, setCancelId] = useState<string | null>(null);
	const [activity, setActivity] = useState<
		{ type: "send" } | { type: "resend" | "cancel"; id: string } | null
	>(null);
	useLocaleChangeBlocker(pending);

	function start(nextActivity: NonNullable<typeof activity>) {
		if (!hydrated) return null;
		const operation = begin(() => {
			setPending(false);
			setCancelId(null);
			setActivity(null);
		});
		if (!operation) return null;
		setPending(true);
		setActivity(nextActivity);
		setMessage("");
		setFailed(false);
		return operation;
	}

	async function send(value: { email: string; role: OrganizationRole }) {
		const operation = start({ type: "send" });
		if (!operation) return;
		let applied = false;
		try {
			const result = await createInvitation({
				signal: operation.signal,
				data: { organizationId: organization.id, ...value },
			});
			if (!operation.current()) return;
			if (result.error) {
				setFailed(true);
				setMessage(operationMessage(result.error));
				if (
					["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(
						result.error.code,
					)
				)
					await router.invalidate({ sync: true });
				return;
			}
			form.reset();
			applied = true;
			if (
				await operation.refresh(
					m.your_invitation_was_created(),
					m.your_invitation_was_created_but_the_list_could(),
				)
			)
				setMessage(m.invitation_created_ask_the_recipient_to_check_their());
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(
				applied
					? m.the_invitation_was_created_but_the_list_could()
					: m.the_invitation_could_not_be_created_refresh_the(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	async function resend(invitation: Invitation) {
		const operation = start({ type: "resend", id: invitation.id });
		if (!operation) return;
		let applied = false;
		try {
			const result = await createInvitation({
				data: {
					organizationId: organization.id,
					email: invitation.email,
					role: invitation.role,
					resend: true,
				},
			});
			if (!operation.current()) return;
			if (result.error) {
				setFailed(true);
				setMessage(operationMessage(result.error));
				if (
					["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(
						result.error.code,
					)
				)
					await router.invalidate({ sync: true });
				return;
			}
			applied = true;
			if (
				await operation.refresh(
					m.your_invitation_resend_was_requested(),
					m.your_invitation_resend_was_requested_but_the_list(),
				)
			)
				setMessage(
					m.invitation_delivery_requested_again_ask_the_recipient_to(),
				);
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(
				applied
					? m.the_resend_was_requested_but_the_list_could()
					: m.the_resend_could_not_be_completed_refresh_the(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	async function cancel(invitationId: string) {
		const operation = start({ type: "cancel", id: invitationId });
		if (!operation) return;
		let applied = false;
		try {
			const result = await cancelInvitation({
				data: { organizationId: organization.id, invitationId },
			});
			if (!operation.current()) return;
			if (result.error) {
				setFailed(true);
				setMessage(operationMessage(result.error));
				if (
					["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(
						result.error.code,
					)
				)
					await router.invalidate({ sync: true });
				return;
			}
			setCancelId(null);
			applied = true;
			if (
				await operation.refresh(
					m.your_invitation_was_canceled(),
					m.your_invitation_was_canceled_but_the_list_could(),
				)
			) {
				setMessage(m.invitation_canceled());
				heading.current?.focus();
			}
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(
				applied
					? m.the_invitation_was_canceled_but_the_list_could()
					: m.the_invitation_could_not_be_canceled_refresh_the(),
			);
		} finally {
			operation.finish();
			if (operation.current()) setPending(false);
		}
	}

	return {
		form,
		heading,
		pending,
		sending,
		activity,
		disabled: !hydrated || pending,
		failed,
		message,
		cancelId,
		setCancelId,
		resend,
		cancel,
		requestCancellation(id: string) {
			setMessage("");
			setFailed(false);
			setCancelId(id);
		},
	};
}
