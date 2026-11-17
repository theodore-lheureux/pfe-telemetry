import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon, UserMinusIcon } from "lucide-react";
import { useOptimistic, useRef, useState, useTransition } from "react";
import type {
	OrganizationRole,
	ProjectSummary,
} from "../../organizations/contracts";
import type { OrganizationMemberSummary } from "../../organizations/member-contracts";
import { AlertDialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { UserAvatar } from "../identity-avatar";
import { TimeDisplay } from "../time-display";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Spinner } from "../ui/spinner";
import { TableCell, TableRow } from "../ui/table";
import { MemberProjectAccess } from "./member-project-access";
import type { useOrganizationMembers } from "./use-organization-members";

const ROLES: OrganizationRole[] = ["member", "admin", "owner"];
function roleChangeLabel(from: OrganizationRole, to: OrganizationRole) {
	if (to === "owner") return m.role_make_owner();
	if (to === "member") return m.role_downgrade_to_member();
	return from === "member"
		? m.role_upgrade_to_admin()
		: m.role_downgrade_to_admin();
}

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
	const [editingAccess, setEditingAccess] = useState(false);
	// You cannot change your own role here; a slip would remove your access.
	const canChangeRole = canManage && !protectedOwner && !self;
	const [role, showRole] = useOptimistic(member.role);
	const [changingRole, startRoleChange] = useTransition();
	function changeRole(target: OrganizationRole) {
		startRoleChange(async () => {
			showRole(target);
			await state.change({ action: "role", memberId: member.id, role: target });
		});
	}
	const canManageProjects = projects.some(
		(project) => project.role === "admin",
	);
	const actions = useRef<HTMLButtonElement>(null);
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
					<div className="flex items-center gap-2" aria-busy={changingRole}>
						<Badge variant="outline">{roleLabel(role)}</Badge>
						{changingRole && <Spinner aria-label={m.saving()} />}
					</div>
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
					{member.twoFactorEnabled ? (
						<Badge
							variant="outline"
							className="border-green-600 text-green-700 dark:text-green-400"
						>
							{m.two_factor_enabled()}
						</Badge>
					) : (
						<span className="text-muted-foreground">
							{m.two_factor_disabled()}
						</span>
					)}
				</TableCell>
				<TableCell>
					<TimeDisplay value={member.joinedAt} mode="relative" />
				</TableCell>
				<TableCell>
					{member.lastSignedInAt ? (
						<TimeDisplay value={member.lastSignedInAt} mode="relative" />
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
							<DropdownMenuContent align="end" className="w-56">
								{canManageProjects && (
									<DropdownMenuItem onSelect={() => setEditingAccess(true)}>
										{m.member_manage_access()}
									</DropdownMenuItem>
								)}
								{canChangeRole &&
									ROLES.filter(
										(target) =>
											target !== member.role &&
											(target !== "owner" || organizationRole === "owner"),
									).map((target) => (
										<DropdownMenuItem
											key={target}
											onSelect={() => changeRole(target)}
										>
											{roleChangeLabel(member.role, target)}
										</DropdownMenuItem>
									))}
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
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setEditingAccess(false);
					}}
				>
					<DialogContent
						className="flex max-h-[calc(100svh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							actions.current?.focus();
						}}
					>
						<DialogHeader className="shrink-0 border-b px-6 py-5 pr-12">
							<DialogTitle className="text-xl font-semibold">
								{m.member_manage_access()}
							</DialogTitle>
							<DialogDescription>
								{member.name
									? `${member.name} · ${member.email}`
									: member.email}
							</DialogDescription>
						</DialogHeader>
						<div className="min-h-0 overflow-y-auto px-6 py-4">
							<MemberProjectAccess
								projects={projects}
								member={member}
								userId={userId}
							/>
						</div>
					</DialogContent>
				</Dialog>
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
						reserveLine={false}
						message={failed ? message : ""}
						kind="error"
						pending={pending}
					/>
					<AlertDialogActions
						cancel={{
							label: m.keep_membership(),
							disabled: pending,
							onClick: () => state.setConfirm(null),
						}}
					>
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
					</AlertDialogActions>
				</AlertDialogContent>
			)}
		</AlertDialog>
	);
}
