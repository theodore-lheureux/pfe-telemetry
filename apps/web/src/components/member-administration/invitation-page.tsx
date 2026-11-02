import { formatDate } from "@pfe/i18n";
import { roleLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import { Link } from "@tanstack/react-router";
import type { inspectInvitation } from "../../organizations/invitation.functions";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { useInvitationResponse } from "./use-invitation-response";

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
		rejected,
		confirmReject,
		setConfirmReject,
		acceptedOrganization,
		decide,
		requestRejection,
	} = useInvitationResponse(invitationId, user.id);
	return (
		<main
			aria-busy={pending}
			className="mx-auto flex min-h-svh max-w-xl flex-col items-start justify-center gap-5 px-6 py-12"
		>
			<Link to="/" className="text-sm underline">
				{m.app_title()}
			</Link>
			<h1
				id="invitation-heading"
				tabIndex={-1}
				className="text-2xl font-semibold"
			>
				{m.organization_invitation()}
			</h1>
			<p className="text-sm text-muted-foreground">
				{m.signed_in_invitation({ email: user.email })}
			</p>
			{message && <p role="alert">{message}</p>}
			{acceptedOrganization ? (
				<div>
					<p role="status">{m.invitation_accepted()}</p>
					<Link
						to="/organizations/$organizationId"
						params={{ organizationId: acceptedOrganization }}
						className="underline"
					>
						{m.open_organization()}
					</Link>
				</div>
			) : rejected ? (
				<p role="status">
					{m.invitation_rejected_rejecting_an_invitation_does_not_remove()}
				</p>
			) : result.error ? (
				<div className="flex flex-col gap-3">
					<p role="alert">
						{result.error.code === "FORBIDDEN"
							? m.sign_in_with_the_invited_email_address_and()
							: result.error.code === "UNAUTHENTICATED"
								? m.your_session_has_ended_sign_in_again_to()
								: m.this_invitation_is_invalid_expired_canceled_or_has()}
					</p>
					<Link to="/account" className="underline">
						{m.manage_your_account_or_sign_out()}
					</Link>
					<Link
						to="/login"
						search={{
							redirect: `/invitations/${encodeURIComponent(invitationId)}`,
						}}
						className="underline"
					>
						{m.sign_in_to_respond()}
					</Link>
				</div>
			) : (
				<>
					<p>
						{m.invitation_join({
							organization: result.data.organizationName,
							role: roleLabel(result.data.role),
						})}
					</p>
					<p className="text-sm">
						{m.invitation_expiry({
							email: result.data.inviterEmail,
							date: formatDate(result.data.expiresAt),
						})}
					</p>
					<p className="text-sm text-muted-foreground">
						{m.joining_gives_you_an_organization_membership_members_still()}
					</p>
					<div className="flex gap-3">
						<Button disabled={disabled} onClick={() => void decide(true)}>
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
					</div>
					<AlertDialog
						open={confirmReject}
						onOpenChange={(open) => {
							if (!pending) setConfirmReject(open);
						}}
					>
						<AlertDialogContent
							aria-busy={pending}
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
							{message && <p role="alert">{message}</p>}
							{pending && <p role="status">{m.saving()}</p>}
							<AlertDialogFooter>
								<Button
									variant="destructive"
									disabled={pending}
									onClick={() => void decide(false)}
								>
									{m.confirm_rejection()}
								</Button>
								<AlertDialogCancel
									variant="outline"
									disabled={pending}
									onClick={() => setConfirmReject(false)}
								>
									{m.keep_invitation()}
								</AlertDialogCancel>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</>
			)}
		</main>
	);
}
