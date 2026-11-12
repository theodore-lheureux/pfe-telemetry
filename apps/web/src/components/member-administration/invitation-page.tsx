import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import type { inspectInvitation } from "../../organizations/invitation.functions";
import { AuthCard } from "../auth-card";
import { ActionStack, AlertDialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { ProjectAvatar } from "../identity-avatar";
import { TimeDisplay } from "../time-display";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { useInvitationResponse } from "./use-invitation-response";

const INSPECTION_ERROR: Partial<Record<string, () => string>> = {
	FORBIDDEN: m.sign_in_with_the_invited_email_address_and,
	UNAUTHENTICATED: m.your_session_has_ended_sign_in_again_to,
};

export function InvitationPage({
	invitationId,
	user,
	result,
}: {
	invitationId: string;
	user: { id: string; email: string };
	result: Awaited<ReturnType<typeof inspectInvitation>>;
}) {
	const {
		pending,
		disabled,
		message,
		kind,
		rejected,
		confirmReject,
		setConfirmReject,
		acceptedOrganization,
		decide,
		requestRejection,
	} = useInvitationResponse(invitationId, user.id);
	// The invitation's state decides what the card shows: the outcome of a decision, why
	// it cannot be answered, or the invitation and its choices.
	const body = () => {
		if (acceptedOrganization)
			return (
				<div className="flex flex-col gap-4">
					<p role="status">{m.invitation_accepted()}</p>
					<Button asChild>
						<Link
							to="/organizations/$organizationId"
							params={{ organizationId: acceptedOrganization }}
						>
							{m.open_organization()}
						</Link>
					</Button>
				</div>
			);
		if (rejected)
			return (
				<p role="status">
					{m.invitation_rejected_rejecting_an_invitation_does_not_remove()}
				</p>
			);
		if (result.error)
			return (
				<div className="flex flex-col gap-4">
					<p role="alert" className="text-sm">
						{(
							INSPECTION_ERROR[result.error.code] ??
							m.this_invitation_is_invalid_expired_canceled_or_has
						)()}
					</p>
					<ActionStack>
						<Button asChild>
							<Link
								to="/login"
								search={{
									redirect: `/invitations/${encodeURIComponent(invitationId)}`,
								}}
							>
								{m.sign_in_to_respond()}
							</Link>
						</Button>
						<Button asChild variant="outline">
							<Link to="/settings" search={{ section: "user" }}>
								{m.manage_your_account_or_sign_out()}
							</Link>
						</Button>
					</ActionStack>
				</div>
			);
		return (
			<>
				<div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
					<ProjectAvatar
						name={result.data.organizationName}
						className="size-10 rounded-md text-sm after:rounded-md"
					/>
					<p className="text-sm font-medium">
						{m.invitation_join({
							organization: result.data.organizationName,
							role: roleLabel(result.data.role),
						})}
					</p>
				</div>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
					<dt className="text-muted-foreground">{m.invited_by()}</dt>
					<dd className="truncate">{result.data.inviterEmail}</dd>
					<dt className="text-muted-foreground">{m.expires()}</dt>
					<dd>
						<TimeDisplay value={result.data.expiresAt} timeZone="UTC" /> UTC
					</dd>
				</dl>
				<p className="text-sm text-muted-foreground">
					{m.joining_gives_you_an_organization_membership_members_still()}
				</p>
				<ActionStack>
					<Button
						disabled={disabled}
						onClick={() => void decide(true)}
						pending={pending && !confirmReject}
						pendingLabel={m.accepting_invitation()}
					>
						{m.accept_invitation()}
					</Button>
					<Button
						id="invitation-reject"
						variant="outline"
						disabled={disabled}
						onClick={requestRejection}
					>
						{m.reject_invitation()}
					</Button>
				</ActionStack>
				<AlertDialog
					open={confirmReject}
					onOpenChange={(open) => {
						if (!pending) setConfirmReject(open);
					}}
				>
					<AlertDialogContent
						onEscapeKeyDown={(event) => {
							if (pending) event.preventDefault();
						}}
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							(
								document.getElementById("invitation-reject") ??
								document.getElementById("invitation-heading")
							)?.focus();
						}}
					>
						<AlertDialogTitle>
							{m.confirm_invitation_rejection()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.reject_this_invitation_you_will_need_a_new()}
						</AlertDialogDescription>
						<FormFeedback
							message={message}
							kind={kind}
							pending={pending}
							pendingMessage={m.rejecting_invitation()}
						/>
						<AlertDialogActions
							cancel={{
								label: m.keep_invitation(),
								disabled: pending,
								onClick: () => setConfirmReject(false),
							}}
						>
							<Button
								variant="destructive"
								disabled={pending}
								pending={pending}
								pendingLabel={m.rejecting_invitation()}
								onClick={() => void decide(false)}
							>
								{m.confirm_rejection()}
							</Button>
						</AlertDialogActions>
					</AlertDialogContent>
				</AlertDialog>
			</>
		);
	};
	return (
		<AuthCard
			headingId="invitation-heading"
			title={m.organization_invitation()}
			description={m.signed_in_invitation({ email: user.email })}
		>
			<FormFeedback
				message={confirmReject ? "" : message}
				kind={kind}
				pending={pending && !confirmReject}
				pendingMessage={m.accepting_invitation()}
				reserveLine={false}
			/>
			{body()}
		</AuthCard>
	);
}
