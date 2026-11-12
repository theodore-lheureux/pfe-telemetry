import { roleLabel, statusLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { currentOrigin } from "../../lib/origin";
import type { OrganizationRole } from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import { CopyStatus, copyState } from "../copy-status";
import { AlertDialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { UserAvatar } from "../identity-avatar";
import { TimeDisplay } from "../time-display";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription } from "../ui/empty";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import { MemberTableHeader, memberTableFeatures } from "./member-table";
import type {
	Invitation,
	useOrganizationInvitations,
} from "./use-organization-invitations";

export function InvitationList({
	invitations,
	asOf,
	organizationRole,
	state,
	members,
	userId,
}: {
	invitations: Invitation[];
	asOf: number;
	organizationRole: OrganizationRole;
	state: ReturnType<typeof useOrganizationInvitations>;
	members: MemberSummary[];
	userId: string;
}) {
	const { pending, disabled, cancelId, heading, failed, message } = state;
	const origin = currentOrigin();
	const [copied, setCopied] = useState("");
	const [copyFailed, setCopyFailed] = useState(false);
	const columns = useMemo<ColumnDef<typeof memberTableFeatures, Invitation>[]>(
		() => [
			{
				accessorKey: "email",
				header: m.invitation_invitee(),
				enableSorting: false,
			},
			{ accessorKey: "role", header: m.settings_level(), enableSorting: false },
			{
				id: "creator",
				accessorFn: (invitation) =>
					members.find((member) => member.userId === invitation.inviterId)
						?.name ?? "",
				header: m.invitation_created_by(),
			},
			{ accessorKey: "createdAt", header: m.invitation_created() },
			{ id: "link", header: m.invitation_link(), enableSorting: false },
			{
				id: "actions",
				header: () => <span className="sr-only">{m.actions()}</span>,
				enableSorting: false,
			},
		],
		[members],
	);
	const table = useTable({
		features: memberTableFeatures,
		data: invitations,
		columns,
		getRowId: (invitation) => invitation.id,
	});
	if (!invitations.length)
		return (
			<Empty className="border border-dashed bg-card p-6">
				<EmptyDescription>{m.no_invitations()}</EmptyDescription>
			</Empty>
		);
	return (
		<div className="rounded-md border bg-card text-card-foreground">
			<Table aria-label={m.invitations()}>
				<MemberTableHeader table={table} />
				<TableBody>
					{table.getRowModel().rows.map(({ original: invitation }) => {
						const creator = members.find(
							(member) => member.userId === invitation.inviterId,
						);
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
									<div className="flex items-center gap-3">
										<Avatar className="size-8">
											<AvatarFallback>
												{invitation.email[0]?.toUpperCase()}
											</AvatarFallback>
										</Avatar>
										<div>
											{invitation.email}
											{expired && (
												<p className="text-xs text-muted-foreground">
													{statusLabel("expired")}
												</p>
											)}
										</div>
									</div>
								</TableCell>
								<TableCell>
									<Badge variant="outline">{roleLabel(invitation.role)}</Badge>
								</TableCell>
								<TableCell>
									{creator ? (
										<div className="flex items-center gap-2">
											<UserAvatar user={creator} className="size-7" />
											<span>
												{creator.userId === userId
													? m.you_label()
													: creator.name || creator.email}
											</span>
										</div>
									) : (
										m.unknown_session_value()
									)}
								</TableCell>
								<TableCell className="whitespace-nowrap">
									<TimeDisplay value={invitation.createdAt} mode="relative" />
								</TableCell>
								<TableCell>
									<div className="flex max-w-80 items-center gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={m.settings_copy()}
											onClick={async () => {
												try {
													await navigator.clipboard.writeText(
														`${origin}/invitations/${encodeURIComponent(invitation.id)}`,
													);
													setCopied(invitation.id);
													setCopyFailed(false);
												} catch {
													setCopyFailed(true);
												}
											}}
										>
											{copied === invitation.id ? (
												<CheckIcon aria-hidden="true" />
											) : (
												<CopyIcon aria-hidden="true" />
											)}
										</Button>
										<Link
											to="/invitations/$invitationId"
											params={{ invitationId: invitation.id }}
											className="truncate text-sm underline-offset-4 hover:underline"
										>
											{origin}/invitations/{invitation.id}
										</Link>
									</div>
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
													<AlertDialogActions
														cancel={{
															label: m.keep_invitation(),
															disabled: pending,
														}}
													>
														<Button
															variant="destructive"
															disabled={pending}
															pending={pending}
															pendingLabel={m.canceling_invitation()}
															onClick={() => void state.cancel(invitation.id)}
														>
															{m.confirm_cancellation()}
														</Button>
													</AlertDialogActions>
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
			<CopyStatus state={copyState(copied, copyFailed)} className="p-2" />
		</div>
	);
}
