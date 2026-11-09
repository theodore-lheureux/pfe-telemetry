import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { useHydrated } from "@tanstack/react-router";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import { DownloadIcon, SearchIcon } from "lucide-react";
import { useMemo } from "react";
import type {
	OrganizationSummary,
	ProjectSummary,
} from "../organizations/contracts";
import type { OrganizationMemberSummary } from "../organizations/member-contracts";
import { FormFeedback } from "./form-feedback";
import { MemberRow } from "./member-administration/member-row";
import {
	MemberTableHeader,
	memberTableFeatures,
} from "./member-administration/member-table";
import { useOrganizationMembers } from "./member-administration/use-organization-members";
import { SettingsSection } from "./settings/settings-section";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

export function OrganizationMembers({
	organization,
	members,
	userId,
	projects,
}: {
	organization: OrganizationSummary;
	members: OrganizationMemberSummary[];
	userId: string;
	projects: ProjectSummary[];
}) {
	const state = useOrganizationMembers(organization, userId);
	const hydrated = useHydrated();
	const owners = members.filter((member) => member.role === "owner").length;
	const locale = getLocale();
	const columns = useMemo<
		ColumnDef<typeof memberTableFeatures, OrganizationMemberSummary>[]
	>(() => {
		const collator = new Intl.Collator(locale, {
			sensitivity: "base",
			numeric: true,
		});
		return [
			{
				id: "member",
				accessorFn: (member) => `${member.name} ${member.email}`,
				header: m.settings_member(),
				sortFn: (a, b) =>
					collator.compare(
						a.original.name || a.original.email,
						b.original.name || b.original.email,
					),
			},
			{
				id: "role",
				accessorFn: (member) =>
					({ owner: 3, admin: 2, member: 1 })[member.role],
				header: m.settings_level(),
				enableGlobalFilter: false,
			},
			{
				id: "projects",
				accessorFn: (member) =>
					member.projectAccess.map((project) => project.name).join(" "),
				header: m.member_project_access(),
			},
			{
				id: "twoFactor",
				accessorFn: (member) => Number(member.twoFactorEnabled),
				header: m.member_two_factor(),
				enableGlobalFilter: false,
			},
			{
				accessorKey: "joinedAt",
				header: m.settings_joined(),
				enableGlobalFilter: false,
			},
			{
				accessorKey: "lastSignedInAt",
				header: m.member_last_sign_in(),
				enableGlobalFilter: false,
				sortUndefined: "last",
			},
			{
				id: "actions",
				header: () => <span className="sr-only">{m.actions()}</span>,
				enableSorting: false,
				enableGlobalFilter: false,
			},
		];
	}, [locale]);
	const table = useTable({
		features: memberTableFeatures,
		data: members,
		columns,
		getRowId: (member) => member.id,
		initialState: { sorting: [{ id: "role", desc: true }] },
		globalFilterFn: "includesString",
	});
	const visible = table.getRowModel().rows.map((row) => row.original);
	function download() {
		const csv = (value: string) =>
			`"${(/^[\s]*[=+@-]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;
		const rows = [
			[
				m.name(),
				m.email_address(),
				m.settings_level(),
				m.settings_joined(),
				m.member_project_access(),
				m.member_two_factor(),
				m.member_last_sign_in(),
			],
			...visible.map((member) => [
				member.name,
				member.email,
				member.role,
				member.joinedAt.toISOString(),
				member.projectAccess.map((project) => project.name).join("; "),
				member.twoFactorEnabled
					? m.two_factor_enabled()
					: m.two_factor_disabled(),
				member.lastSignedInAt?.toISOString() ?? "",
			]),
		];
		const url = URL.createObjectURL(
			new Blob(
				["\uFEFF", rows.map((row) => row.map(csv).join(",")).join("\r\n")],
				{ type: "text/csv;charset=utf-8" },
			),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "recount-members.csv";
		link.click();
		URL.revokeObjectURL(url);
	}
	return (
		<SettingsSection
			id="members-heading"
			title={m.organization_members()}
			description={m.settings_members_description()}
			headingRef={state.heading}
		>
			<FormFeedback
				message={state.confirm ? "" : state.message}
				pending={state.pending && !state.confirm}
				kind={state.failed ? "error" : "success"}
				reserveLine={false}
			/>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="relative w-full max-w-xs">
					<SearchIcon
						aria-hidden="true"
						className="absolute top-2.5 left-3 size-4 text-muted-foreground"
					/>
					<Input
						type="search"
						disabled={!hydrated}
						value={table.state.globalFilter ?? ""}
						onChange={(event) => table.setGlobalFilter(event.target.value)}
						className="pl-9"
						aria-label={m.settings_search_members()}
						placeholder={m.settings_search_members()}
					/>
				</div>
				<Button variant="outline" onClick={download} disabled={!hydrated}>
					<DownloadIcon aria-hidden="true" />
					{m.settings_download_members()}
				</Button>
			</div>
			<div className="rounded-md border bg-card text-card-foreground">
				<Table aria-label={m.organization_members()}>
					<MemberTableHeader table={table} />
					<TableBody>
						{visible.map((member) => (
							<MemberRow
								key={member.id}
								member={member}
								self={member.userId === userId}
								organizationRole={organization.role}
								owners={owners}
								state={state}
								projects={projects}
								userId={userId}
							/>
						))}
						{!visible.length && (
							<TableRow>
								<TableCell colSpan={7} className="text-muted-foreground">
									{m.settings_no_members()}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
		</SettingsSection>
	);
}
