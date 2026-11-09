import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import type { OrganizationRole } from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
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
import { MemberRoleForm } from "./role-forms";
import type { useOrganizationMembers } from "./use-organization-members";

export function MemberRow({
	member,
	self,
	organizationRole,
	owners,
	state,
}: {
	member: MemberSummary;
	self: boolean;
	organizationRole: OrganizationRole;
	owners: number;
	state: ReturnType<typeof useOrganizationMembers>;
}) {
	const canManage = organizationRole !== "member";
	const protectedOwner =
		member.role === "owner" && (organizationRole !== "owner" || owners <= 1);
	const { pending, disabled, confirm, failed, message, heading } = state;
	return (
		<li className="flex flex-wrap items-center justify-between gap-4 p-4">
			<AlertDialog
				open={confirm === member.id}
				onOpenChange={(open) => {
					if (!pending) state.setConfirm(open ? member.id : null);
				}}
			>
				<div>
					<p className="font-medium">
						{self
							? m.you_suffix({ name: member.name || member.email })
							: member.name || member.email}
					</p>
					<p className="text-sm text-muted-foreground">
						{member.email} · {roleLabel(member.role)}
					</p>
				</div>
				{canManage && !protectedOwner && (
					<MemberRoleForm
						key={`${member.role}:${organizationRole}`}
						member={member}
						allowOwner={organizationRole === "owner"}
						disabled={disabled}
						onSave={(role) =>
							state.change({ action: "role", memberId: member.id, role })
						}
					/>
				)}
				{!protectedOwner && (self || canManage) && (
					<AlertDialogTrigger asChild>
						<Button
							variant="outline"
							disabled={disabled}
							aria-label={
								self
									? m.leave_member_named({ email: member.email })
									: m.remove_member_named({ email: member.email })
							}
							onClick={() => state.requestRemoval(member.id)}
						>
							{self ? m.leave_organization() : m.remove_member()}
							<span className="sr-only">: {member.email}</span>
						</Button>
					</AlertDialogTrigger>
				)}
				{protectedOwner && self && (
					<p className="text-sm">
						{m.promote_a_replacement_owner_before_leaving_or_changing()}
					</p>
				)}
				{confirm === member.id && !protectedOwner && (self || canManage) && (
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
							{m.confirm_removal_named({ email: member.email })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{self
								? m.leave_this_organization()
								: m.remove_member_question({ email: member.email })}{" "}
							{m.this_removes_their_organization_membership_and_all_explicit()}
						</AlertDialogDescription>
						<FormFeedback
							message={failed ? message : ""}
							kind="error"
							pending={pending}
						/>
						<AlertDialogFooter>
							<Button
								variant="destructive"
								disabled={pending}
								pending={pending}
								pendingLabel={m.saving()}
								onClick={() =>
									void state.change(
										self
											? { action: "leave" }
											: { action: "remove", memberId: member.id },
									)
								}
							>
								{self ? m.confirm_leave() : m.confirm_removal()}
							</Button>
							<AlertDialogCancel
								variant="outline"
								disabled={pending}
								onClick={() => state.setConfirm(null)}
							>
								{m.keep_membership()}
							</AlertDialogCancel>
						</AlertDialogFooter>
					</AlertDialogContent>
				)}
			</AlertDialog>
		</li>
	);
}
