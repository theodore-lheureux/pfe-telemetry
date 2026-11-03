import { formatDate } from "@pfe/i18n";
import { roleLabel, statusLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import type { OrganizationRole } from "../../organizations/contracts";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import type {
	Invitation,
	useOrganizationInvitations,
} from "./use-organization-invitations";

export function InvitationList({
	invitations,
	asOf,
	organizationRole,
	state,
}: {
	invitations: Invitation[];
	asOf: number;
	organizationRole: OrganizationRole;
	state: ReturnType<typeof useOrganizationInvitations>;
}) {
	const { pending, disabled, cancelId, heading, failed, message } = state;
	if (!invitations.length)
		return (
			<p className="text-sm text-muted-foreground">{m.no_invitations()}</p>
		);
	return (
		<ul className="divide-y rounded-md border bg-card text-card-foreground">
			{invitations.map((invitation) => {
				const expired = invitation.expiresAt.getTime() <= asOf;
				const liveForEmail = invitations.some(
					(entry) =>
						entry.email === invitation.email &&
						entry.status === "pending" &&
						entry.expiresAt.getTime() > asOf,
				);
				return (
					<li
						key={invitation.id}
						className="flex flex-wrap items-center justify-between gap-3 p-4"
					>
						<div>
							<p className="font-medium">{invitation.email}</p>
							<p className="text-sm text-muted-foreground">
								{roleLabel(invitation.role)} ·{" "}
								{statusLabel(
									invitation.status === "pending" && expired
										? "expired"
										: invitation.status,
								)}{" "}
								· {m.expires_date({ date: formatDate(invitation.expiresAt) })}
							</p>
						</div>
						{invitation.status === "pending" && !expired && (
							<AlertDialog
								open={cancelId === invitation.id}
								onOpenChange={(open) => {
									if (!pending) state.setCancelId(open ? invitation.id : null);
								}}
							>
								<AlertDialogTrigger asChild>
									<Button
										variant="outline"
										disabled={disabled}
										onClick={() => state.requestCancellation(invitation.id)}
										aria-label={m.cancel_invitation_named({
											email: invitation.email,
										})}
									>
										{m.cancel_invitation()}
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent
									aria-busy={pending}
									onCloseAutoFocus={(event) => {
										if (pending) {
											event.preventDefault();
											heading.current?.focus();
										}
									}}
									onEscapeKeyDown={(event) => {
										if (pending) event.preventDefault();
									}}
								>
									<AlertDialogTitle>
										{m.cancel_invitation_named({ email: invitation.email })}
									</AlertDialogTitle>
									<AlertDialogDescription>
										{m.cancel_this_invitation_its_link_will_no_longer()}
									</AlertDialogDescription>
									{failed && message && (
										<p role="alert" className="text-sm text-destructive">
											{message}
										</p>
									)}
									<AlertDialogFooter>
										{pending && <p role="status">{m.saving()}</p>}
										<AlertDialogCancel disabled={pending}>
											{m.keep_invitation()}
										</AlertDialogCancel>
										<Button
											variant="destructive"
											disabled={pending}
											onClick={() => void state.cancel(invitation.id)}
										>
											{m.confirm_cancellation()}
										</Button>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						)}
						{invitation.status === "pending" &&
							(!expired || !liveForEmail) &&
							(invitation.role !== "owner" || organizationRole === "owner") && (
								<Button
									variant="outline"
									disabled={disabled}
									onClick={() => void state.resend(invitation)}
									aria-label={m.resend_invitation_named({
										email: invitation.email,
									})}
								>
									{m.resend()}
								</Button>
							)}
					</li>
				);
			})}
		</ul>
	);
}
