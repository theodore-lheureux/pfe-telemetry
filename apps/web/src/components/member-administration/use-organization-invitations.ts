import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useRef, useState } from "react";
import type {
	OrganizationRole,
	OrganizationSummary,
} from "../../organizations/contracts";
import {
	cancelInvitation,
	createInvitations,
	resendInvitation,
} from "../../organizations/invitation.functions";
import type {
	InvitationBatchItem,
	InvitationBatchResult,
	InvitationRecipientInput,
	InvitationSummary,
} from "../../organizations/invitation-contracts";
import { useAppForm } from "../app-form";
import { useAppMutation } from "../use-app-mutation";
import { usePageConfirmation } from "../use-page-confirmation";

export type Invitation = InvitationSummary;
type Action =
	| { type: "send"; recipients: InvitationRecipientInput[]; message: string }
	| { type: "resend"; invitation: Invitation; id: string }
	| { type: "cancel"; id: string };

export function useOrganizationInvitations(
	organization: OrganizationSummary,
	userId: string,
	onSent?: () => void,
) {
	const heading = useRef<HTMLHeadingElement>(null);
	const [cancelId, setCancelId] = usePageConfirmation<string>();
	const [inviting, setInviting] = usePageConfirmation<true>();
	const [activity, setActivity] = useState<Action | null>(null);
	const [outcomes, setOutcomes] = useState<Record<string, InvitationBatchItem>>(
		{},
	);
	const [stage, setStage] = useState<"idle" | "refreshing" | "closing">("idle");
	const mutation = useAppMutation<Action, InvitationBatchResult>({
		userId,
		save: async (action, signal) => {
			if (action.type === "send")
				return createInvitations({
					data: {
						organizationId: organization.id,
						recipients: action.recipients,
						message: action.message,
					},
					signal,
				});
			const result =
				action.type === "cancel"
					? await cancelInvitation({
							data: {
								organizationId: organization.id,
								invitationId: action.id,
							},
							signal,
						})
					: await resendInvitation({
							data: {
								organizationId: organization.id,
								email: action.invitation.email,
								role: action.invitation.role,
								recipientName: action.invitation.recipientName,
								message: action.invitation.message,
							},
							signal,
						});
			return result.error ? result : { data: { results: [] }, error: null };
		},
		saved: ({ type }) =>
			type === "send"
				? m.invite_batch_processed()
				: type === "resend"
					? m.your_invitation_resend_was_requested()
					: m.your_invitation_was_canceled(),
		refreshFailed: ({ type }) =>
			type === "send"
				? m.invite_batch_refresh_failed()
				: type === "resend"
					? m.your_invitation_resend_was_requested_but_the_list()
					: m.your_invitation_was_canceled_but_the_list_could(),
		unknown: ({ type }) =>
			type === "send"
				? m.invite_batch_unknown()
				: type === "resend"
					? m.the_resend_could_not_be_completed_refresh_the()
					: m.the_invitation_could_not_be_canceled_refresh_the(),
	});
	const blocked =
		activity?.type === "send" &&
		["uncertain", "refresh-failed"].includes(mutation.status);
	const values: {
		recipients: {
			id: string;
			email: string;
			role: OrganizationRole;
			recipientName: string;
		}[];
		message: string;
	} = {
		recipients: [
			{ id: "initial", email: "", role: "member", recipientName: "" },
		],
		message: "",
	};
	const form = useAppForm({
		defaultValues: values,
		onSubmit: async ({ value }) => {
			if (mutation.disabled || blocked || stage === "closing") return;
			const recipients = value.recipients
				.filter((recipient) => outcomes[recipient.id]?.status !== "created")
				.map(({ id, ...recipient }) => ({ clientId: id, ...recipient }));
			if (!recipients.length) return;
			const action: Action = {
				type: "send",
				recipients,
				message: value.message,
			};
			setActivity(action);
			const saved = await mutation.submit(action);
			if (!saved || saved.error) return;
			const next = {
				...outcomes,
				...Object.fromEntries(
					saved.data.results.map((result) => [result.clientId, result]),
				),
			};
			const remaining = value.recipients.filter(
				(recipient) => next[recipient.id]?.status !== "created",
			).length;
			const created = value.recipients.length - remaining;
			setStage("refreshing");
			const success = remaining
				? m.invite_batch_partial({ created, remaining })
				: created === 1
					? m.invitation_created_ask_the_recipient_to_check_their()
					: m.invite_batch_created({ count: created });
			if (!(await saved.refresh(undefined, success))) {
				setStage("idle");
				return;
			}
			// Apply results together only after the one refresh; never remove rows while sending.
			if (remaining) {
				setOutcomes(next);
				setStage("idle");
			} else {
				setStage("closing");
				setInviting(null);
				onSent?.();
			}
		},
	});
	const sending = useSelector(form.store, (state) => state.isSubmitting);
	async function change(action: Exclude<Action, { type: "send" }>) {
		setActivity(action);
		const saved = await mutation.submit(action);
		if (!saved || saved.error) return;
		setCancelId(null);
		const refreshed = await saved.refresh(
			undefined,
			action.type === "resend"
				? m.invitation_delivery_requested_again_ask_the_recipient_to()
				: m.invitation_canceled(),
		);
		if (refreshed && action.type === "cancel") heading.current?.focus();
	}
	const partial =
		activity?.type === "send" &&
		Object.values(outcomes).some((result) => result.status !== "created");
	const formPending = sending || mutation.pending || stage === "closing";
	const pendingLabel =
		stage === "refreshing" || stage === "closing"
			? m.invite_batch_refreshing()
			: activity?.type === "send" && activity.recipients.length > 1
				? m.invite_batch_sending({ count: activity.recipients.length })
				: m.sending_invitation();
	return {
		form,
		heading,
		sending,
		activity,
		outcomes,
		pendingLabel,
		formPending,
		pending: mutation.pending || sending,
		disabled: mutation.disabled || sending,
		formDisabled: mutation.disabled || formPending || blocked,
		failed: mutation.kind !== "success" || partial,
		feedbackKind: blocked
			? ("warning" as const)
			: partial
				? ("error" as const)
				: mutation.kind,
		message: mutation.message,
		cancelId,
		setCancelId,
		inviting: !!inviting,
		setInviting,
		openInvitationForm() {
			mutation.clearMessage();
			setOutcomes({});
			setStage("idle");
			form.reset();
			setInviting(true);
		},
		clearOutcome(id: string) {
			if (!outcomes[id] || outcomes[id].status === "created") return;
			mutation.clearMessage();
			setOutcomes((previous) => {
				if (!previous[id] || previous[id].status === "created") return previous;
				const { [id]: _, ...remaining } = previous;
				return remaining;
			});
		},
		resend: (invitation: Invitation) =>
			change({ type: "resend", invitation, id: invitation.id }),
		cancel: (id: string) => change({ type: "cancel", id }),
		requestCancellation(id: string) {
			mutation.clearMessage();
			setCancelId(id);
		},
	};
}
