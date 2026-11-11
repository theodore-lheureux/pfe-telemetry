import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ProjectMembershipSummary,
	ProjectSummary,
} from "../organizations/contracts";
import type { MemberSummary } from "../organizations/member-contracts";
import { FormFeedback } from "./form-feedback";
import { UserAvatar } from "./identity-avatar";
import {
	MemberTableHeader,
	memberTableFeatures,
} from "./member-administration/member-table";
import { ProjectGrantRow } from "./member-administration/project-grant-row";
import { ProjectGrantForm } from "./member-administration/role-forms";
import { useProjectGrants } from "./member-administration/use-project-grants";
import { SettingsPageHeading } from "./settings/settings-page-heading";
import { SettingsSection } from "./settings/settings-section";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

const inheritedRoles = [{ role: "owner" }, { role: "admin" }] as const;

export function ProjectGrants({
	project,
	members,
	grants,
	userId,
}: {
	project: ProjectSummary;
	members: MemberSummary[];
	grants: ProjectMembershipSummary[];
	userId: string;
}) {
	const state = useProjectGrants(project, userId);
	const [adding, setAdding] = useState(false);
	const [selected, setSelected] = useState("");
	const added = useRef(false);
	const candidates = members.filter(
		(member) =>
			member.role === "member" &&
			!grants.some((grant) => grant.memberId === member.id),
	);
	const candidate =
		candidates.find((member) => member.id === selected) ?? candidates[0];
	useEffect(() => {
		if (selected && grants.some((grant) => grant.memberId === selected)) {
			added.current = true;
			setAdding(false);
			setSelected("");
		}
	}, [grants, selected]);
	const data = useMemo(
		() =>
			members.filter((member) =>
				grants.some((grant) => grant.memberId === member.id),
			),
		[members, grants],
	);
	const columns = useMemo<
		ColumnDef<typeof memberTableFeatures, MemberSummary>[]
	>(
		() => [
			{
				id: "user",
				accessorFn: (member) => `${member.name} ${member.email}`,
				header: m.settings_member(),
			},
			{
				id: "role",
				accessorFn: (member) =>
					grants.find((grant) => grant.memberId === member.id)?.role,
				header: m.settings_level(),
			},
			{
				id: "actions",
				header: () => <span className="sr-only">{m.actions()}</span>,
				enableSorting: false,
			},
		],
		[grants],
	);
	const table = useTable({
		features: memberTableFeatures,
		columns,
		data,
		getRowId: (member) => member.id,
	});
	const roleColumns = useMemo<
		ColumnDef<typeof memberTableFeatures, (typeof inheritedRoles)[number]>[]
	>(
		() => [
			{
				id: "role",
				accessorFn: (row) => roleLabel(row.role),
				header: m.organization_role(),
			},
			{
				id: "members",
				accessorFn: (row) =>
					members.filter((member) => member.role === row.role).length,
				header: m.members(),
			},
			{ id: "level", header: m.settings_level(), enableSorting: false },
		],
		[members],
	);
	const roleTable = useTable({
		features: memberTableFeatures,
		columns: roleColumns,
		data: inheritedRoles,
	});
	return (
		<div className="flex flex-col gap-8">
			<SettingsPageHeading
				headingRef={state.heading}
				headingId="grants-heading"
			/>
			<SettingsSection
				id="project-default-access"
				title={m.project_default_access()}
			>
				<div className="max-w-48">
					<NativeSelect
						aria-label={m.project_default_access()}
						value="none"
						disabled
					>
						<NativeSelectOption value="none">
							{m.project_no_access()}
						</NativeSelectOption>
					</NativeSelect>
				</div>
				<p className="text-sm text-muted-foreground">
					{m.projects_are_private_grant_access_only_to_current()}
				</p>
			</SettingsSection>
			<FormFeedback
				message={state.confirmation || adding ? "" : state.message}
				pending={state.pending && !state.confirmation && !adding}
				kind={state.failed ? "error" : "success"}
				reserveLine={false}
			/>
			<section
				className="flex flex-col gap-4"
				aria-labelledby="project-members-heading"
			>
				<div className="flex items-center justify-between">
					<h2 id="project-members-heading" className="text-base font-semibold">
						{m.members()}
					</h2>
					<Dialog
						open={adding}
						onOpenChange={(open) => {
							if (!state.pending) {
								setAdding(open);
								if (!open) setSelected("");
							}
						}}
					>
						<DialogTrigger asChild>
							<Button
								variant="outline"
								disabled={state.disabled || !candidates.length}
							>
								<PlusIcon aria-hidden="true" />
								{m.project_add_member()}
							</Button>
						</DialogTrigger>
						<DialogContent
							onCloseAutoFocus={(event) => {
								if (added.current) {
									added.current = false;
									event.preventDefault();
									state.heading.current?.focus();
								}
							}}
							showCloseButton={!state.pending}
							onEscapeKeyDown={(event) => {
								if (state.pending) event.preventDefault();
							}}
							onInteractOutside={(event) => {
								if (state.pending) event.preventDefault();
							}}
						>
							<DialogHeader>
								<DialogTitle>{m.project_add_member()}</DialogTitle>
								<DialogDescription>
									{m.projects_are_private_grant_access_only_to_current()}
								</DialogDescription>
							</DialogHeader>
							{candidate ? (
								<>
									<Label htmlFor="grant-candidate">
										{m.project_select_member()}
									</Label>
									<NativeSelect
										id="grant-candidate"
										value={candidate.id}
										disabled={state.disabled}
										onChange={(event) => setSelected(event.target.value)}
									>
										{candidates.map((member) => (
											<NativeSelectOption key={member.id} value={member.id}>
												{member.name || member.email}
											</NativeSelectOption>
										))}
									</NativeSelect>
									<ProjectGrantForm
										key={candidate.id}
										member={candidate}
										disabled={state.disabled}
										onSave={async (role) => {
											setSelected(candidate.id);
											await state.change(candidate, role);
										}}
									/>
								</>
							) : (
								<p>{m.project_no_candidates()}</p>
							)}
							<FormFeedback
								message={state.failed ? state.message : ""}
								kind={state.failed ? "error" : "success"}
								pending={state.pending}
								reserveLine={false}
							/>
						</DialogContent>
					</Dialog>
				</div>
				<div className="rounded-md border bg-card">
					<Table aria-label={m.project_members()}>
						<MemberTableHeader table={table} />
						<TableBody>
							{table.getRowModel().rows.map(({ original: member }) => (
								<ProjectGrantRow
									key={member.id}
									member={member}
									grant={grants.find((grant) => grant.memberId === member.id)}
									self={member.userId === userId}
									state={state}
								/>
							))}
							{!data.length && (
								<TableRow>
									<TableCell colSpan={3} className="text-muted-foreground">
										{m.project_no_explicit_members()}
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
			</section>
			<SettingsSection
				id="project-inherited-roles"
				title={m.project_roles()}
				description={m.project_inherited_roles_description()}
			>
				<div className="rounded-md border bg-card">
					<Table aria-label={m.project_roles()}>
						<MemberTableHeader table={roleTable} />
						<TableBody>
							{roleTable.getRowModel().rows.map(({ original: { role } }) => (
								<TableRow key={role} className="h-16">
									<TableCell className="font-medium">
										{roleLabel(role)}
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap gap-1">
											{members
												.filter((member) => member.role === role)
												.map((member) => (
													<UserAvatar
														key={member.id}
														user={member}
														className="size-7"
													/>
												))}
										</div>
									</TableCell>
									<TableCell>
										<Badge variant="outline">{m.role_admin()}</Badge>
										<span className="ml-2 text-xs text-muted-foreground">
											{m.project_inherited_access()}
										</span>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</SettingsSection>
		</div>
	);
}
