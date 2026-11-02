import { roleLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import type { ProjectMembershipSummary } from "../../organizations/contracts";
import type { MemberSummary } from "../../organizations/member-contracts";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
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
		<li className="flex flex-wrap items-center justify-between gap-3 p-4">
			<div>
				<p className="font-medium">
					{self
						? m.you_suffix({ name: member.name || member.email })
						: member.name || member.email}
				</p>
				<p className="text-sm text-muted-foreground">{member.email}</p>
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
			{!implicit && (
				<ProjectGrantForm
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
			{grant && (
				<Button
					variant="outline"
					disabled={disabled}
					onClick={(event) =>
						state.requestConfirmation(member.id, null, event.currentTarget)
					}
					aria-label={m.remove_grant_named({ email: member.email })}
				>
					{m.remove_explicit_grant()}
				</Button>
			)}
			{confirmation?.memberId === member.id && (
				<AlertDialog
					open
					onOpenChange={(open) => {
						if (!open && !pending) state.setConfirmation(null);
					}}
				>
					<AlertDialogContent
						aria-busy={pending}
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
						{failed && message && (
							<p role="alert" className="text-sm text-destructive">
								{message}
							</p>
						)}
						<AlertDialogFooter>
							{pending && <p role="status">{m.saving()}</p>}
							<Button
								variant="destructive"
								disabled={pending}
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
		</li>
	);
}
