import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Trash2Icon } from "lucide-react";
import type { ProjectMembershipSummary } from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import { FormFeedback } from "../form-feedback";
import { UserAvatar } from "../identity-avatar";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { TableCell, TableRow } from "../ui/table";
import { ProjectGrantForm } from "./role-forms";
import type { useProjectGrants } from "./use-project-grants";

export function ProjectGrantRow({
	member,
	grant,
	self,
	state,
}: {
	member: MemberSummary;
	grant: ProjectMembershipSummary | undefined;
	self: boolean;
	state: ReturnType<typeof useProjectGrants>;
}) {
	const implicit = member.role !== "member";
	const { confirmation, pending, disabled, failed, message } = state;
	return (
		<TableRow className="h-16">
			<TableCell>
				<div className="flex items-center gap-3">
					<UserAvatar user={member} className="size-8" />
					<div>
						<p className="font-medium">
							{self
								? m.you_suffix({ name: member.name || member.email })
								: member.name || member.email}
						</p>
						{member.name && (
							<p className="text-sm text-muted-foreground">{member.email}</p>
						)}
						<p className="text-sm">
							{implicit
								? m.implicit_role({ role: roleLabel(member.role) })
								: grant
									? m.explicit_role({ role: roleLabel(grant.role) })
									: m.no_project_access()}
							{implicit && grant
								? ` · ${m.redundant_role({ role: roleLabel(grant.role) })}`
								: ""}
						</p>
					</div>
				</div>
			</TableCell>
			<TableCell>
				{!implicit && (
					<ProjectGrantForm
						compact
						key={grant?.role ?? "none"}
						member={member}
						role={grant?.role}
						disabled={disabled}
						onSave={async (role, trigger) => {
							if (self && role !== "admin")
								state.requestConfirmation(member.id, role, trigger);
							else await state.change(member, role);
						}}
					/>
				)}
				{implicit && (
					<span className="text-sm text-muted-foreground">
						{m.project_inherited_access()}
					</span>
				)}
			</TableCell>
			<TableCell className="w-12">
				{grant && (
					<Button
						variant="outline"
						size="icon"
						disabled={disabled}
						onClick={(event) =>
							state.requestConfirmation(member.id, null, event.currentTarget)
						}
						aria-label={m.remove_grant_named({ email: member.email })}
					>
						<Trash2Icon aria-hidden="true" />
					</Button>
				)}
			</TableCell>
			{confirmation?.memberId === member.id && (
				<AlertDialog
					open
					onOpenChange={(open) => {
						if (!open && !pending) state.setConfirmation(null);
					}}
				>
					<AlertDialogContent
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							const trigger = state.confirmationTrigger.current;
							(trigger?.isConnected && !trigger.disabled
								? trigger
								: state.heading.current
							)?.focus();
						}}
						onEscapeKeyDown={(event) => {
							if (pending) event.preventDefault();
						}}
					>
						<AlertDialogTitle>
							{m.confirm_access_named({ email: member.email })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{implicit
								? m.remove_this_redundant_explicit_grant_implicit_administrator_access()
								: self
									? m.this_removes_your_project_administrator_access_you_will()
									: m.remove_access_question({ email: member.email })}
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
								onClick={() => void state.change(member, confirmation.role)}
							>
								{m.confirm_access_change()}
							</Button>
							<AlertDialogCancel
								variant="outline"
								disabled={pending}
								onClick={() => state.setConfirmation(null)}
							>
								{m.keep_current_access()}
							</AlertDialogCancel>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</TableRow>
	);
}
