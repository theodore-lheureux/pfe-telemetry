import { project } from "../db/schema";
import type { ProjectSummary } from "./contracts";

export const projectSummaryColumns = {
	id: project.id,
	organizationId: project.organizationId,
	name: project.name,
	tags: project.tags,
	projectGroup: project.projectGroup,
	timeZone: project.timeZone,
	weekStartsOn: project.weekStartsOn,
} satisfies Pick<typeof project, Exclude<keyof ProjectSummary, "role">>;
