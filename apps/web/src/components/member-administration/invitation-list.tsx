import { formatDate } from "@recount/i18n";
import { roleLabel, statusLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import type { OrganizationRole } from "../../organizations/contracts";
import { FormFeedback } from "../form-feedback";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
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
	return (
		<div className="rounded-md border bg-card text-card-foreground">
			<Table aria-label={m.invitations()}>
				<TableHeader>
					<TableRow>
						<TableHead>{m.email_address()}</TableHead>
						<TableHead>{m.settings_level()}</TableHead>
						<TableHead>{m.settings_status()}</TableHead>
						<TableHead>{m.expires()}</TableHead>
						<TableHead>
							<span className="sr-only">{m.actions()}</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{!invitations.length && (
						<TableRow>
							<TableCell colSpan={5} className="text-muted-foreground">
								{m.no_invitations()}
							</TableCell>
						</TableRow>
					)}
					{invitations.map((invitation) => {
						const expired = invitation.expiresAt.getTime() <= asOf;
						const liveForEmail = invitations.some(
							(entry) =>
								entry.email === invitation.email &&
								entry.status === "pending" &&
								entry.expiresAt.getTime() > asOf,
						);
						return (
							<TableRow key={invitation.id} className="h-14">
								<TableCell className="font-medium">
									{invitation.email}
								</TableCell>
								<TableCell>{roleLabel(invitation.role)}</TableCell>
								<TableCell>
									{statusLabel(
										invitation.status === "pending" && expired
											? "expired"
											: invitation.status,
									)}
								</TableCell>
								<TableCell className="whitespace-nowrap">
									{formatDate(invitation.expiresAt)}
								</TableCell>
								<TableCell>
									<div className="flex items-center justify-end gap-2">
										{invitation.status === "pending" && !expired && (
											<AlertDialog
												open={cancelId === invitation.id}
												onOpenChange={(open) => {
													if (!pending)
														state.setCancelId(open ? invitation.id : null);
												}}
											>
												<AlertDialogTrigger asChild>
													<Button
														variant="outline"
														disabled={disabled}
														onClick={() =>
															state.requestCancellation(invitation.id)
														}
														aria-label={m.cancel_invitation_named({
															email: invitation.email,
														})}
													>
														{m.cancel_invitation()}
													</Button>
												</AlertDialogTrigger>
												<AlertDialogContent
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
														{m.cancel_invitation_named({
															email: invitation.email,
														})}
													</AlertDialogTitle>
													<AlertDialogDescription>
														{m.cancel_this_invitation_its_link_will_no_longer()}
													</AlertDialogDescription>
													<FormFeedback
														message={failed ? message : ""}
														kind="error"
														pending={pending}
														pendingMessage={m.canceling_invitation()}
													/>
													<AlertDialogFooter>
														<AlertDialogCancel disabled={pending}>
															{m.keep_invitation()}
														</AlertDialogCancel>
														<Button
															variant="destructive"
															disabled={pending}
															pending={pending}
															pendingLabel={m.canceling_invitation()}
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
											(invitation.role !== "owner" ||
												organizationRole === "owner") && (
												<Button
													variant="outline"
													disabled={disabled}
													pending={
														pending &&
														state.activity?.type === "resend" &&
														state.activity.id === invitation.id
													}
													pendingLabel={m.resending_invitation()}
													onClick={() => void state.resend(invitation)}
													aria-label={m.resend_invitation_named({
														email: invitation.email,
													})}
												>
													{m.resend()}
												</Button>
											)}
									</div>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
