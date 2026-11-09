import { m } from "@recount/i18n/messages";
import type { ProjectSummary } from "../../organizations/contracts";
import type { OrganizationMemberSummary } from "../../organizations/member-contracts";
import { FormFeedback } from "../form-feedback";
import { Table, TableBody } from "../ui/table";
import { ProjectGrantRow } from "./project-grant-row";
import { useProjectGrants } from "./use-project-grants";

function ProjectAccess({
	project,
	member,
	userId,
}: {
	project: ProjectSummary;
	member: OrganizationMemberSummary;
	userId: string;
}) {
	const state = useProjectGrants(project, userId);
	const existing = member.projectAccess.find(
		(entry) => entry.id === project.id,
	);
	const grant = existing
		? {
				projectId: project.id,
				memberId: member.id,
				userId: member.userId,
				role: existing.role,
			}
		: undefined;
	return (
		<section className="flex flex-col gap-2" aria-label={project.name}>
			<h4 className="font-medium">{project.name}</h4>
			<Table>
				<TableBody>
					<ProjectGrantRow
						member={member}
						grant={grant}
						self={member.userId === userId}
						state={state}
					/>
				</TableBody>
			</Table>
			<FormFeedback
				message={state.confirmation ? "" : state.message}
				kind={state.failed ? "error" : "success"}
				pending={state.pending && !state.confirmation}
				reserveLine={false}
			/>
		</section>
	);
}

export function MemberProjectAccess({
	projects,
	member,
	userId,
}: {
	projects: ProjectSummary[];
	member: OrganizationMemberSummary;
	userId: string;
}) {
	if (member.role !== "member")
		return (
			<p className="text-sm text-muted-foreground">
				{m.project_inherited_roles_description()}
			</p>
		);
	return (
		<div className="flex flex-col gap-4">
			{projects
				.filter((project) => project.role === "admin")
				.map((project) => (
					<ProjectAccess
						key={project.id}
						project={project}
						member={member}
						userId={userId}
					/>
				))}
		</div>
	);
}
