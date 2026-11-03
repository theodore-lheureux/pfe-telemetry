import { and, eq } from "drizzle-orm";
import type { getDatabase } from "../db/client.server";
import { member, organization, project, projectMember } from "../db/schema";
import type {
	OrganizationRole,
	ProjectReference,
	ProjectRole,
	ProjectSummary,
} from "./contracts";
import { OperationError } from "./errors";

type Database = ReturnType<typeof getDatabase>;

export interface Actor {
	id: string;
}

export function resolveOrganizationRole(
	value: string,
): OrganizationRole | null {
	const roles = value.split(",").map((role) => role.trim());
	if (roles.some((role) => !["owner", "admin", "member"].includes(role)))
		return null;
	return roles.includes("owner")
		? "owner"
		: roles.includes("admin")
			? "admin"
			: "member";
}

export function resolveProjectRole(
	organizationRole: OrganizationRole,
	assignedRole: ProjectRole | null,
): ProjectRole | null {
	return organizationRole === "owner" || organizationRole === "admin"
		? "admin"
		: assignedRole;
}

export async function requireOrganization(
	database: Database,
	actor: Actor,
	organizationId: string,
) {
	const [entry] = await database
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			memberId: member.id,
			role: member.role,
		})
		.from(organization)
		.innerJoin(
			member,
			and(
				eq(member.organizationId, organization.id),
				eq(member.userId, actor.id),
			),
		)
		.where(eq(organization.id, organizationId));
	const role = entry && resolveOrganizationRole(entry.role);
	if (!entry || !role)
		throw new OperationError("NOT_FOUND", "Organization not found");
	return { ...entry, role };
}

export async function requireOrganizationMember(
	database: Database,
	organizationId: string,
	memberId: string,
) {
	const [target] = await database
		.select({ userId: member.userId })
		.from(member)
		.where(
			and(eq(member.id, memberId), eq(member.organizationId, organizationId)),
		);
	if (!target)
		throw new OperationError("NOT_FOUND", "Organization member not found");
	return target;
}

export async function requireProject(
	database: Database,
	actor: Actor,
	reference: ProjectReference,
	action: "read" | "admin" = "read",
) {
	const membership = await requireOrganization(
		database,
		actor,
		reference.organizationId,
	);
	const [entry] = await database
		.select({
			id: project.id,
			organizationId: project.organizationId,
			name: project.name,
			slug: project.slug,
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
				eq(project.id, reference.projectId),
				eq(project.organizationId, reference.organizationId),
			),
		);
	const role = entry && resolveProjectRole(membership.role, entry.assignedRole);
	if (!entry || !role)
		throw new OperationError("NOT_FOUND", "Project not found");
	if (action === "admin" && role !== "admin")
		throw new OperationError(
			"FORBIDDEN",
			"Project administrator access required",
		);
	return {
		id: entry.id,
		organizationId: entry.organizationId,
		name: entry.name,
		slug: entry.slug,
		role,
	} satisfies ProjectSummary;
}
