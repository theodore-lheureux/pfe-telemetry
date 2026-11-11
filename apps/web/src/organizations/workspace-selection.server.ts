import type { getDatabase } from "../db/client.server";
import { OperationError } from "../lib/operation-error";
import type { Actor } from "./access.server";
import { listOrganizations } from "./organizations.server";
import { listProjects } from "./projects.server";
import type { WorkspacePreference } from "./workspace-preference";

export async function resolveWorkspace(
	database: ReturnType<typeof getDatabase>,
	actor: Actor,
	requested: { organizationId?: string; projectId?: string },
	preference: WorkspacePreference,
) {
	const organizations = await listOrganizations(database, actor);
	if (
		requested.organizationId &&
		!organizations.some((org) => org.id === requested.organizationId)
	)
		throw new OperationError("NOT_FOUND", "Organization not found");
	const ordered = requested.organizationId
		? organizations.filter((org) => org.id === requested.organizationId)
		: [...organizations].sort(
				(a, b) =>
					Number(b.id === preference.organizationId) -
					Number(a.id === preference.organizationId),
			);
	let empty:
		| {
				organization: (typeof organizations)[number];
				projects: Awaited<ReturnType<typeof listProjects>>;
		  }
		| undefined;
	for (const organization of ordered) {
		const projects = await listProjects(database, actor, organization.id);
		const project =
			projects.find(
				(project) =>
					project.id ===
					(requested.projectId ?? preference.projects[organization.id]),
			) ?? (requested.projectId ? undefined : projects[0]);
		if (requested.projectId && !project)
			throw new OperationError("NOT_FOUND", "Project not found");
		if (project || requested.organizationId)
			return { organizations, organization, project, projects };
		empty ??= { organization, projects };
	}
	return {
		organizations,
		organization: empty?.organization,
		project: undefined,
		projects: empty?.projects ?? [],
	};
}
