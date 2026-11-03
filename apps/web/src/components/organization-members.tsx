import { m } from "@pfe/i18n/messages";
import type { OrganizationSummary } from "../organizations/contracts";
import type { MemberSummary } from "../organizations/member-contracts";
import { MemberRow } from "./member-administration/member-row";
import { useOrganizationMembers } from "./member-administration/use-organization-members";

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
	return (
		<section
			aria-labelledby="members-heading"
			aria-busy={state.pending}
			className="flex flex-col gap-4"
		>
			<h1
				ref={state.heading}
				tabIndex={-1}
				id="members-heading"
				className="text-2xl font-semibold"
			>
				{m.organization_members()}
			</h1>
			<p className="text-sm text-muted-foreground">
				{m.organization_owners_and_administrators_have_implicit_administrator_access()}
			</p>
			<p className="text-sm text-muted-foreground">
				{m.to_replace_an_owner_an_existing_owner_must()}
			</p>
			<p role={state.failed ? "alert" : "status"} className="text-sm">
				{state.message}
			</p>
			<ul className="divide-y rounded-md border bg-card text-card-foreground">
				{members.map((member) => (
					<MemberRow
						key={member.id}
						member={member}
						self={member.userId === userId}
						organizationRole={organization.role}
						owners={owners}
						state={state}
					/>
				))}
			</ul>
		</section>
	);
}
