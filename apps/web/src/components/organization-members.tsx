import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { ArrowDownUpIcon, DownloadIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import type { OrganizationSummary } from "../organizations/contracts";
import type { MemberSummary } from "../organizations/member-contracts";
import { FormFeedback } from "./form-feedback";
import { MemberRow } from "./member-administration/member-row";
import { useOrganizationMembers } from "./member-administration/use-organization-members";
import { SettingsSection } from "./settings/settings-section";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";

export function OrganizationMembers({
	organization,
	members,
	userId,
}: {
	organization: OrganizationSummary;
	members: MemberSummary[];
	userId: string;
}) {
	const state = useOrganizationMembers(organization, userId);
	const owners = members.filter((member) => member.role === "owner").length;
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<{
		column: "name" | "role" | "joinedAt";
		descending: boolean;
	}>({ column: "role", descending: false });
	const collator = new Intl.Collator(getLocale(), {
		sensitivity: "base",
		numeric: true,
	});
	const roleOrder = { owner: 0, admin: 1, member: 2 };
	const visible = members
		.filter((member) =>
			`${member.name} ${member.email}`
				.toLocaleLowerCase(getLocale())
				.includes(query.trim().toLocaleLowerCase(getLocale())),
		)
		.sort((a, b) => {
			const compared =
				sort.column === "role"
					? roleOrder[a.role] - roleOrder[b.role]
					: sort.column === "joinedAt"
						? a.joinedAt.getTime() - b.joinedAt.getTime()
						: collator.compare(a.name || a.email, b.name || b.email);
			return (
				(sort.descending ? -compared : compared) ||
				collator.compare(a.email, b.email)
			);
		});
	function download() {
		const csv = (value: string) =>
			`"${(/^[\s]*[=+@-]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;
		const rows = [
			[m.name(), m.email_address(), m.settings_level(), m.settings_joined()],
			...visible.map((member) => [
				member.name,
				member.email,
				member.role,
				member.joinedAt.toISOString(),
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
			<p className="text-sm text-muted-foreground">
				{m.to_replace_an_owner_an_existing_owner_must()}
			</p>
			{owners === 1 &&
				members.some(
					(member) => member.userId === userId && member.role === "owner",
				) && (
					<p className="text-sm text-muted-foreground">
						{m.promote_a_replacement_owner_before_leaving_or_changing()}
					</p>
				)}
			<FormFeedback
				message={state.confirm ? "" : state.message}
				pending={state.pending && !state.confirm}
				kind={state.failed ? "error" : "success"}
			/>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="relative w-full max-w-xs">
					<SearchIcon
						aria-hidden="true"
						className="absolute top-2.5 left-3 size-4 text-muted-foreground"
					/>
					<Input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="pl-9"
						aria-label={m.settings_search_members()}
						placeholder={m.settings_search_members()}
					/>
				</div>
				<Button variant="outline" onClick={download}>
					<DownloadIcon aria-hidden="true" />
					{m.settings_download_members()}
				</Button>
			</div>
			<div className="rounded-md border bg-card text-card-foreground">
				<Table aria-label={m.organization_members()}>
					<TableHeader>
						<TableRow>
							{(
								[
									["name", m.settings_member()],
									["role", m.settings_level()],
									["joinedAt", m.settings_joined()],
								] as const
							).map(([column, label]) => (
								<TableHead
									key={column}
									aria-sort={
										sort.column === column
											? sort.descending
												? "descending"
												: "ascending"
											: "none"
									}
								>
									<Button
										variant="ghost"
										size="sm"
										className="-ml-2"
										aria-label={m.settings_sort_by({ column: label })}
										onClick={() =>
											setSort({
												column,
												descending: sort.column === column && !sort.descending,
											})
										}
									>
										{label}
										<ArrowDownUpIcon aria-hidden="true" className="size-3.5" />
									</Button>
								</TableHead>
							))}
							<TableHead className="w-12">
								<span className="sr-only">{m.actions()}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{visible.map((member) => (
							<MemberRow
								key={member.id}
								member={member}
								self={member.userId === userId}
								organizationRole={organization.role}
								owners={owners}
								state={state}
							/>
						))}
						{!visible.length && (
							<TableRow>
								<TableCell colSpan={4} className="text-muted-foreground">
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
