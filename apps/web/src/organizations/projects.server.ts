import { randomUUID } from "node:crypto";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { member, project, projectMember } from "../db/schema";
import { createOnce } from "../lib/create-once.server";
import {
	type Actor,
	requireOrganization,
	requireOrganizationMember,
	requireProject,
	resolveProjectRole,
} from "./access.server";
import type {
	CreateProjectInput,
	ProjectCustomizationInput,
	ProjectMembershipInput,
	ProjectMembershipReference,
	ProjectMembershipSummary,
	ProjectReference,
	ProjectSummary,
	UpdateProjectInput,
} from "./contracts";
import { OperationError } from "./errors";
import {
	changedProjectTags,
	parseProjectCustomization,
} from "./project-customization";
import { parseCreateProjectInput } from "./validation";

type Database = ReturnType<typeof getDatabase>;

export async function listProjects(
	database: Database,
	actor: Actor,
	organizationId: string,
) {
	const membership = await requireOrganization(database, actor, organizationId);
	const entries = await database
		.select({
			id: project.id,
			organizationId: project.organizationId,
			name: project.name,
			slug: project.slug,
			tags: project.tags,
			projectGroup: project.projectGroup,
			timeZone: project.timeZone,
			weekStartsOn: project.weekStartsOn,
			assignedRole: projectMember.role,
		})
		.from(project)
		.leftJoin(
			projectMember,
			and(
				eq(projectMember.projectId, project.id),
				eq(projectMember.memberId, membership.memberId),
			),
		)
		.where(
			and(
				eq(project.organizationId, organizationId),
				or(
					sql`${membership.role === "owner" || membership.role === "admin"}`,
					sql`${projectMember.memberId} IS NOT NULL`,
				),
			),
		)
		.orderBy(asc(project.name), asc(project.id));
	return entries.flatMap(({ assignedRole, ...entry }) => {
		const role = resolveProjectRole(membership.role, assignedRole);
		return role ? [{ ...entry, role }] : [];
	}) satisfies ProjectSummary[];
}

export function getProject(
	database: Pick<Database, "select">,
	actor: Actor,
	reference: ProjectReference,
) {
	return requireProject(database, actor, reference);
}

export async function createProject(
	database: Database,
	actor: Actor,
	input: CreateProjectInput,
) {
	input = parseCreateProjectInput(input);
	return createOnce(database, {
		actorId: actor.id,
		requestId: input.requestId,
		scope: {
			operation: "create-project",
			organizationId: input.organizationId,
			projectId: null,
		},
		values: [input.name, input.slug],
		resourceId: randomUUID(),
		authorize: async (tx) => {
			const membership = await requireOrganization(
				tx,
				actor,
				input.organizationId,
			);
			if (membership.role === "member")
				throw new OperationError(
					"FORBIDDEN",
					"Organization administrator access required",
				);
			return membership;
		},
		create: async (tx, id) => {
			await tx.insert(project).values({
				id,
				organizationId: input.organizationId,
				name: input.name,
				slug: input.slug,
				createdBy: actor.id,
			});
		},
		read: (tx, projectId) =>
			getProject(tx, actor, {
				organizationId: input.organizationId,
				projectId,
			}),
	});
}

export async function updateProject(
	database: Database,
	actor: Actor,
	input: UpdateProjectInput,
) {
	const access = await requireProject(database, actor, input, "admin");
	const [updated] = await database
		.update(project)
		.set({ name: input.name })
		.where(
			and(
				eq(project.id, input.projectId),
				eq(project.organizationId, input.organizationId),
			),
		)
		.returning();
	if (!updated) throw new OperationError("NOT_FOUND", "Project not found");
	return { ...access, name: updated.name } satisfies ProjectSummary;
}

export async function updateProjectCustomization(
	database: Database,
	actor: Actor,
	value: ProjectCustomizationInput,
) {
	const input = parseProjectCustomization(value);
	return database.transaction(async (tx) => {
		await requireProject(tx, actor, input, "admin");
		// Serialize tag edits without replacing another administrator's changes.
		const [current] = await tx
			.select()
			.from(project)
			.where(
				and(
					eq(project.id, input.projectId),
					eq(project.organizationId, input.organizationId),
				),
			)
			.for("update");
		if (!current) throw new OperationError("NOT_FOUND", "Project not found");
		const patch =
			input.action === "add-tag" || input.action === "remove-tag"
				? { tags: changedProjectTags(current.tags, input) }
				: input.action === "group"
					? { projectGroup: input.projectGroup }
					: input.action === "time-zone"
						? { timeZone: input.timeZone }
						: { weekStartsOn: input.weekStartsOn };
		await tx
			.update(project)
			.set(patch)
			.where(
				and(
					eq(project.id, input.projectId),
					eq(project.organizationId, input.organizationId),
				),
			);
		return requireProject(tx, actor, input, "admin");
	});
}

export async function listProjectMembers(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
) {
	await requireProject(database, actor, reference, "admin");
	return database
		.select({
			projectId: projectMember.projectId,
			memberId: projectMember.memberId,
			userId: member.userId,
			role: projectMember.role,
		})
		.from(projectMember)
		.innerJoin(member, eq(member.id, projectMember.memberId))
		.where(eq(projectMember.projectId, reference.projectId))
		.orderBy(asc(projectMember.memberId));
}

export async function setProjectMember(
	database: Database,
	actor: Actor,
	input: ProjectMembershipInput,
) {
	await requireProject(database, actor, input, "admin");
	const target = await requireOrganizationMember(
		database,
		input.organizationId,
		input.memberId,
	);
	await database
		.insert(projectMember)
		.values(input)
		.onConflictDoUpdate({
			target: [projectMember.projectId, projectMember.memberId],
			set: { role: input.role },
		});
	return {
		projectId: input.projectId,
		memberId: input.memberId,
		userId: target.userId,
		role: input.role,
	} satisfies ProjectMembershipSummary;
}

export async function removeProjectMember(
	database: Database,
	actor: Actor,
	input: ProjectMembershipReference,
) {
	await requireProject(database, actor, input, "admin");
	await requireOrganizationMember(
		database,
		input.organizationId,
		input.memberId,
	);
	await database
		.delete(projectMember)
		.where(
			and(
				eq(projectMember.projectId, input.projectId),
				eq(projectMember.organizationId, input.organizationId),
				eq(projectMember.memberId, input.memberId),
			),
		);
	return { removed: true };
}
