import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import {
	MoreHorizontalIcon,
	ShieldIcon,
	UserMinusIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	OrganizationRole,
	ProjectSummary,
} from "../../organizations/contracts";
import type { OrganizationMemberSummary } from "../../organizations/member-contracts";
import { FormFeedback } from "../form-feedback";
import { UserAvatar } from "../identity-avatar";
import { SessionTime } from "../settings/session-time";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TableCell, TableRow } from "../ui/table";
import { MemberProjectAccess } from "./member-project-access";
import { MemberRoleForm } from "./role-forms";
import type { useOrganizationMembers } from "./use-organization-members";

export function MemberRow({
	member,
	self,
	organizationRole,
	owners,
	state,
	projects,
	userId,
}: {
	member: OrganizationMemberSummary;
	self: boolean;
	organizationRole: OrganizationRole;
	owners: number;
	state: ReturnType<typeof useOrganizationMembers>;
	projects: ProjectSummary[];
	userId: string;
}) {
	const canManage = organizationRole !== "member";
	const protectedOwner =
		member.role === "owner" && (organizationRole !== "owner" || owners <= 1);
	const { pending, disabled, confirm, failed, message, heading } = state;
	const [editing, setEditing] = useState(false);
	const [editingAccess, setEditingAccess] = useState(false);
	const canManageProjects = projects.some(
		(project) => project.role === "admin",
	);
	const actions = useRef<HTMLButtonElement>(null);
	const editor = useRef<HTMLFieldSetElement>(null);
	const previousRole = useRef(member.role);
	useEffect(() => {
		if (previousRole.current !== member.role) {
			previousRole.current = member.role;
			setEditing(false);
		}
	}, [member.role]);
	return (
		<AlertDialog
			open={confirm === member.id}
			onOpenChange={(open) => {
				if (!pending) state.setConfirm(open ? member.id : null);
			}}
		>
			<TableRow className="h-16">
				<TableCell>
					<div className="flex items-center gap-3">
						<UserAvatar user={member} className="size-8 shrink-0" />
						<div>
							<p className="font-medium">
								{self
									? m.you_suffix({ name: member.name || member.email })
									: member.name || member.email}
							</p>
							{member.name && (
								<p className="text-sm text-muted-foreground">{member.email}</p>
							)}
						</div>
					</div>
				</TableCell>
				<TableCell>
					<Badge variant="outline">{roleLabel(member.role)}</Badge>
				</TableCell>
				<TableCell>
					<div className="flex max-w-64 flex-wrap gap-1">
						{member.projectAccess.map((project) => (
							<Badge key={project.id} variant="outline" asChild>
								<Link
									to="/organizations/$organizationId/projects/$projectId/executions"
									params={{
										organizationId: member.organizationId,
										projectId: project.id,
									}}
								>
									{project.name}
								</Link>
							</Badge>
						))}
					</div>
				</TableCell>
				<TableCell>
					<Badge
						variant="outline"
						className={
							member.twoFactorEnabled
								? "border-green-600 text-green-700 dark:text-green-400"
								: "border-amber-600 text-amber-700 dark:text-amber-400"
						}
					>
						{member.twoFactorEnabled
							? m.two_factor_enabled()
							: m.two_factor_disabled()}
					</Badge>
				</TableCell>
				<TableCell>
					<SessionTime value={member.joinedAt} relative />
				</TableCell>
				<TableCell>
					{member.lastSignedInAt ? (
						<SessionTime value={member.lastSignedInAt} relative />
					) : (
						<span className="text-muted-foreground">
							{m.unknown_session_value()}
						</span>
					)}
				</TableCell>
				<TableCell className="text-right">
					{(canManageProjects || (!protectedOwner && (self || canManage))) && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									ref={actions}
									variant="ghost"
									size="icon-sm"
									disabled={disabled}
									aria-label={m.settings_member_actions({
										email: member.email,
									})}
								>
									<MoreHorizontalIcon aria-hidden="true" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="end"
								className="w-56"
								onCloseAutoFocus={(event) => {
									if (editing) {
										event.preventDefault();
										editor.current?.querySelector("select")?.focus();
									}
								}}
							>
								{canManageProjects && (
									<DropdownMenuItem
										onSelect={() => {
											setEditing(false);
											setEditingAccess(true);
										}}
									>
										{m.member_manage_access()}
									</DropdownMenuItem>
								)}
								{canManage && !protectedOwner && (
									<DropdownMenuItem
										onSelect={() => {
											setEditingAccess(false);
											setEditing(true);
										}}
									>
										<ShieldIcon aria-hidden="true" />
										{m.settings_change_role()}
									</DropdownMenuItem>
								)}
								{!protectedOwner && (self || canManage) && (
									<DropdownMenuItem
										variant="destructive"
										aria-label={
											self
												? m.leave_member_named({ email: member.email })
												: m.remove_member_named({ email: member.email })
										}
										onSelect={() => state.requestRemoval(member.id)}
									>
										<UserMinusIcon aria-hidden="true" />
										{self ? m.leave_organization() : m.remove_member()}
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</TableCell>
			</TableRow>
			{editingAccess && canManageProjects && (
				<TableRow>
					<TableCell colSpan={7} className="bg-muted/30 whitespace-normal">
						<div className="flex justify-between gap-3">
							<h3 className="font-semibold">{m.member_manage_access()}</h3>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={m.close()}
								onClick={() => {
									setEditingAccess(false);
									actions.current?.focus();
								}}
							>
								<XIcon aria-hidden="true" />
							</Button>
						</div>
						<MemberProjectAccess
							projects={projects}
							member={member}
							userId={userId}
						/>
					</TableCell>
				</TableRow>
			)}
			{editing && canManage && !protectedOwner && (
				<TableRow>
					<TableCell colSpan={7} className="bg-muted/30 whitespace-normal">
						<fieldset ref={editor} className="flex min-w-0 flex-col gap-3 py-2">
							<legend className="sr-only">{m.settings_change_role()}</legend>
							<div className="flex items-start justify-between gap-4">
								<p className="max-w-2xl text-sm text-muted-foreground">
									{m.settings_member_role_description()}
								</p>
								<Button
									variant="ghost"
									size="icon-sm"
									disabled={pending}
									aria-label={m.close()}
									onClick={() => {
										setEditing(false);
										actions.current?.focus();
									}}
								>
									<XIcon aria-hidden="true" />
								</Button>
							</div>
							<MemberRoleForm
								key={`${member.role}:${organizationRole}`}
								member={member}
								allowOwner={organizationRole === "owner"}
								disabled={disabled}
								onSave={(role) =>
									state.change({ action: "role", memberId: member.id, role })
								}
							/>
						</fieldset>
					</TableCell>
				</TableRow>
			)}
			{confirm === member.id && !protectedOwner && (self || canManage) && (
				<AlertDialogContent
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (pending) {
							heading.current?.focus();
						} else actions.current?.focus();
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
	);
}
