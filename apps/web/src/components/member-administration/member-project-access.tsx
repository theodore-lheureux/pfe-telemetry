import { m } from "@recount/i18n/messages";
import type { ProjectSummary } from "../../organizations/contracts";
import type { OrganizationMemberSummary } from "../../organizations/member-contracts";
import { FormFeedback } from "../form-feedback";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
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
	const feedback = state.confirmation ? "" : state.message;
	return (
		<>
			<ProjectGrantRow
				member={member}
				grant={grant}
				self={member.userId === userId}
				state={state}
				label={
					<h4
						ref={state.heading}
						tabIndex={-1}
						className="font-medium outline-none"
					>
						{project.name}
					</h4>
				}
			/>
			{(feedback || (state.pending && !state.confirmation)) && (
				<TableRow className="hover:bg-transparent">
					<TableCell colSpan={3} className="pt-0">
						<FormFeedback
							message={feedback}
							kind={state.failed ? "error" : "success"}
							pending={state.pending && !state.confirmation}
							reserveLine={false}
						/>
					</TableCell>
				</TableRow>
			)}
		</>
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
		<Table>
			<TableBody>
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
			</TableBody>
		</Table>
	);
}
