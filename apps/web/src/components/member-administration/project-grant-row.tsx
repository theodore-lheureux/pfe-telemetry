import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type {
	ProjectMembershipSummary,
	ProjectRole,
} from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import { AutoSaveSelect } from "../auto-save-select";
import { AlertDialogActions } from "../dialog-actions";
import { UserAvatar } from "../identity-avatar";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { TableCell, TableRow } from "../ui/table";
import type { useProjectGrants } from "./use-project-grants";

export function ProjectGrantRow({
	member,
	grant,
	self,
	state,
	label,
}: {
	member: MemberSummary;
	grant: ProjectMembershipSummary | undefined;
	self: boolean;
	state: ReturnType<typeof useProjectGrants>;
	/** Replaces the member's identity, for views that already name the member. */
	label?: ReactNode;
}) {
	const implicit = member.role !== "member";
	const { confirmation, pending, disabled } = state;
	return (
		<TableRow className={label ? undefined : "h-16"}>
			<TableCell>
				<div className="flex items-center gap-3">
					{!label && <UserAvatar user={member} className="size-8" />}
					<div>
						{label ?? (
							<p className="font-medium">
								{self
									? m.you_suffix({ name: member.name || member.email })
									: member.name || member.email}
							</p>
						)}
						{!label && member.name && (
							<p className="text-sm text-muted-foreground">{member.email}</p>
						)}
						<p className={label ? "text-sm text-muted-foreground" : "text-sm"}>
							{implicit && m.implicit_role({ role: roleLabel(member.role) })}
							{!implicit &&
								grant &&
								m.explicit_role({ role: roleLabel(grant.role) })}
							{!implicit && !grant && m.no_project_access()}
							{implicit && grant
								? ` · ${m.redundant_role({ role: roleLabel(grant.role) })}`
								: ""}
						</p>
					</div>
				</div>
			</TableCell>
			<TableCell>
				{!implicit && (
					<AutoSaveSelect<ProjectRole | "none">
						value={grant?.role ?? "none"}
						label={m.project_role_for({ email: member.email })}
						options={[
							{ value: "none", label: m.no_project_access() },
							{ value: "viewer", label: m.role_viewer() },
							{ value: "member", label: m.role_member() },
							{ value: "admin", label: m.role_admin() },
						]}
						onSave={(choice) => {
							const role = choice === "none" ? null : choice;
							// Removing access, or lowering your own, asks first.
							if (!role || (self && role !== "admin")) {
								state.requestConfirmation(
									member.id,
									role,
									document.activeElement as HTMLElement | null,
								);
								return;
							}
							return state.change(member, role);
						}}
					/>
				)}
				{implicit && (
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground">
							{m.project_inherited_access()}
						</span>
						{grant && (
							<Button
								variant="outline"
								size="icon"
								disabled={disabled}
								onClick={(event) =>
									state.requestConfirmation(
										member.id,
										null,
										event.currentTarget,
									)
								}
								aria-label={m.remove_grant_named({ email: member.email })}
							>
								<Trash2Icon aria-hidden="true" />
							</Button>
						)}
					</div>
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
							(trigger?.isConnected && !trigger.matches(":disabled")
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
							{implicit &&
								m.remove_this_redundant_explicit_grant_implicit_administrator_access()}
							{!implicit &&
								self &&
								m.this_removes_your_project_administrator_access_you_will()}
							{!implicit &&
								!self &&
								m.remove_access_question({ email: member.email })}
						</AlertDialogDescription>
						<AlertDialogActions
							cancel={{
								label: m.keep_current_access(),
								disabled: pending,
								onClick: () => state.setConfirmation(null),
							}}
						>
							<Button
								variant="destructive"
								disabled={pending}
								pending={pending}
								pendingLabel={m.saving()}
								onClick={() => void state.change(member, confirmation.role)}
							>
								{m.confirm_access_change()}
							</Button>
						</AlertDialogActions>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</TableRow>
	);
}
