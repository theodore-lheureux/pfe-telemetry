import { m } from "@pfe/i18n/messages";
import type {
	ProjectMembershipSummary,
	ProjectSummary,
} from "../organizations/contracts";
import type { MemberSummary } from "../organizations/member-contracts";
import { ProjectGrantRow } from "./member-administration/project-grant-row";
import { useProjectGrants } from "./member-administration/use-project-grants";

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
	return (
		<section
			className="flex flex-col gap-4"
			aria-labelledby="grants-heading"
			aria-busy={state.pending}
		>
			<h1
				ref={state.heading}
				tabIndex={-1}
				id="grants-heading"
				className="text-2xl font-semibold"
			>
				{m.project_access()}
			</h1>
			<p className="text-sm text-muted-foreground">
				{m.projects_are_private_grant_access_only_to_current()}
			</p>
			<p className="text-sm text-muted-foreground">
				{m.organization_owners_and_administrators_have_implicit_project_administrator()}
			</p>
			<p role={state.failed ? "alert" : "status"} className="text-sm">
				{state.message}
			</p>
			<ul className="divide-y rounded-md border bg-card text-card-foreground">
				{members.map((member) => (
					<ProjectGrantRow
						key={member.id}
						member={member}
						grant={grants.find((entry) => entry.memberId === member.id)}
						self={member.userId === userId}
						state={state}
					/>
				))}
			</ul>
		</section>
	);
}
