import { and, eq } from "drizzle-orm";
import type { createAuth } from "../auth/create-auth.server";
import { gravatarUrl } from "../components/avatar.server";
import type { getDatabase } from "../db/client.server";
import { member, projectMember, user } from "../db/schema";
import {
	type Actor,
	requireOrganization,
	requireOrganizationMember,
	requireProject,
	resolveOrganizationRole,
} from "./access.server";
import type { ProjectReference } from "./contracts";
import { OperationError } from "./errors";
import type {
	MemberReference,
	MemberRoleInput,
	MemberSummary,
	OrganizationMemberSummary,
} from "./member-contracts";
import { listProjects } from "./projects.server";

type Auth = ReturnType<typeof createAuth>;
type Database = ReturnType<typeof getDatabase>;

export async function listOrganizationMembers(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	organizationId: string,
): Promise<OrganizationMemberSummary[]> {
	const organization = await requireOrganization(
		database,
		actor,
		organizationId,
	);
	const [members, projects, grants, signIns] = await Promise.all([
		listMembers(database, auth, headers, actor, organizationId),
		listProjects(database, actor, organizationId),
		database
			.select({
				memberId: projectMember.memberId,
				projectId: projectMember.projectId,
				role: projectMember.role,
			})
			.from(projectMember)
			.where(eq(projectMember.organizationId, organizationId)),
		database
			.select({
				id: user.id,
				lastSignedInAt: user.lastSignedInAt,
				twoFactorEnabled: user.twoFactorEnabled,
			})
			.from(user)
			.innerJoin(member, eq(member.userId, user.id))
			.where(eq(member.organizationId, organizationId)),
	]);
	return members.map((entry) => ({
		...entry,
		organizationId,
		projectAccess: projects.flatMap((project) => {
			const role =
				entry.role !== "member"
					? ("admin" as const)
					: grants.find(
							(grant) =>
								grant.memberId === entry.id && grant.projectId === project.id,
						)?.role;
			return role ? [{ id: project.id, name: project.name, role }] : [];
		}),
		lastSignedInAt:
			organization.role !== "member" || entry.userId === actor.id
				? (signIns.find((user) => user.id === entry.userId)?.lastSignedInAt ??
					null)
				: null,
		twoFactorEnabled:
			signIns.find((user) => user.id === entry.userId)?.twoFactorEnabled ??
			false,
	}));
}

export async function listProjectGrantCandidates(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	reference: ProjectReference,
) {
	await requireProject(database, actor, reference, "admin");
	return listMembers(database, auth, headers, actor, reference.organizationId);
}

export async function listMembers(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	organizationId: string,
) {
	await requireOrganization(database, actor, organizationId);
	const entries: MemberSummary[] = [];
	let total: number;
	do {
		const page = await auth.api.listMembers({
			headers,
			query: {
				organizationId,
				limit: 100,
				offset: entries.length,
				sortBy: "id",
				sortDirection: "asc",
			},
		});
		total = page.total;
		for (const entry of page.members) {
			const role = resolveOrganizationRole(entry.role);
			if (!role) throw new Error("Unsupported organization role");
			entries.push({
				id: entry.id,
				userId: entry.userId,
				name: entry.user.name,
				email: entry.user.email,
				role,
				image: entry.user.image ?? null,
				gravatarUrl: gravatarUrl(entry.user.email),
				joinedAt: entry.createdAt,
			});
		}
		if (!page.members.length) break;
	} while (entries.length < total);
	return entries;
}

export async function updateRole(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	input: MemberRoleInput,
) {
	const membership = await requireOrganization(
		database,
		actor,
		input.organizationId,
	);
	if (membership.role === "member")
		throw new OperationError("FORBIDDEN", "Administrator access required");
	await requireOrganizationMember(
		database,
		input.organizationId,
		input.memberId,
	);
	await auth.api.updateMemberRole({ headers, body: input });
	return { memberId: input.memberId };
}

export async function removeMember(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	input: MemberReference,
) {
	const membership = await requireOrganization(
		database,
		actor,
		input.organizationId,
	);
	if (membership.role === "member")
		throw new OperationError("FORBIDDEN", "Administrator access required");
	const [target] = await database
		.select({ role: member.role })
		.from(member)
		.where(
			and(
				eq(member.id, input.memberId),
				eq(member.organizationId, input.organizationId),
			),
		);
	if (!target)
		throw new OperationError("NOT_FOUND", "Organization member not found");
	if (
		membership.role !== "owner" &&
		resolveOrganizationRole(target.role) === "owner"
	)
		throw new OperationError(
			"FORBIDDEN",
			"Only an organization owner can remove another owner",
		);
	await auth.api.removeMember({
		headers,
		body: {
			organizationId: input.organizationId,
			memberIdOrEmail: input.memberId,
		},
	});
	return { memberId: input.memberId };
}

export async function leaveOrganization(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	organizationId: string,
) {
	await requireOrganization(database, actor, organizationId);
	await auth.api.leaveOrganization({ headers, body: { organizationId } });
	return { organizationId };
}
