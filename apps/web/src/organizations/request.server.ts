import { APIError } from "better-auth/api";
import { getAuth } from "../auth/auth.server";
import type { createAuth } from "../auth/create-auth.server";
import { applicationSession } from "../auth/session.server";
import { getDatabase } from "../db/client.server";
import { type Actor, requireProject } from "./access.server";
import type {
	CreateProjectInput,
	OperationResult,
	OrganizationInput,
	ProjectMembershipInput,
	ProjectMembershipReference,
	ProjectReference,
	UpdateProjectInput,
} from "./contracts";
import { OperationError, type OperationErrorCode } from "./errors";
import type {
	CreateInvitationInput,
	InvitationReference,
	OrganizationInvitationReference,
} from "./invitation-contracts";
import * as invitations from "./invitations.server";
import type { MemberReference, MemberRoleInput } from "./member-contracts";
import * as members from "./members.server";
import * as organizations from "./organizations.server";
import * as projects from "./projects.server";

type Database = ReturnType<typeof getDatabase>;
type Auth = ReturnType<typeof createAuth>;

function postgresCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return;
	if ("code" in error && typeof error.code === "string") return error.code;
	return "cause" in error ? postgresCode(error.cause) : undefined;
}

function ownerConstraint(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (
		"code" in error &&
		error.code === "23514" &&
		"constraint" in error &&
		error.constraint === "organization_must_retain_owner"
	)
		return true;
	return "cause" in error && ownerConstraint(error.cause);
}

async function result<T>(
	operation: () => Promise<T>,
): Promise<OperationResult<T>> {
	try {
		return { data: await operation(), error: null };
	} catch (error) {
		if (error instanceof OperationError)
			return {
				data: null,
				error: {
					code: error.code,
					message: error.message,
					reason: error.reason,
				},
			};
		if (postgresCode(error) === "23505")
			return {
				data: null,
				error: {
					code: "CONFLICT",
					message: "This slug or membership is already in use",
				},
			};
		if (
			ownerConstraint(error) ||
			(error instanceof APIError &&
				[
					"YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
					"YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
				].includes(error.body?.code ?? ""))
		)
			return {
				data: null,
				error: {
					code: "CONFLICT",
					message:
						"The organization must retain an owner. Ask an existing owner to promote another member to owner, then retry. Administrators cannot appoint owners.",
					reason: "LAST_OWNER",
				},
			};
		if (error instanceof APIError) {
			if (error.statusCode >= 500) throw error;
			const statusCodes: Partial<Record<number, OperationErrorCode>> = {
				401: "UNAUTHENTICATED",
				403: "FORBIDDEN",
				404: "NOT_FOUND",
				409: "CONFLICT",
				429: "RATE_LIMITED",
			};
			const duplicate = [
				"ORGANIZATION_SLUG_ALREADY_TAKEN",
				"ORGANIZATION_ALREADY_EXISTS",
				"USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
				"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
			].includes(error.body?.code ?? "");
			const unavailable = [
				"INVITATION_NOT_FOUND",
				"ORGANIZATION_NOT_FOUND",
				"MEMBER_NOT_FOUND",
			].includes(error.body?.code ?? "");
			return {
				data: null,
				error: {
					code: duplicate
						? "CONFLICT"
						: unavailable
							? "NOT_FOUND"
							: (statusCodes[error.statusCode] ?? "INVALID_INPUT"),
					message: error.body?.message ?? "Organization operation failed",
				},
			};
		}
		throw error;
	}
}

export function getOrganizationRequests() {
	return createOrganizationRequests(getDatabase(), getAuth());
}

export function createOrganizationRequests(database: Database, auth: Auth) {
	async function currentUser(headers: Headers): Promise<Actor> {
		return (await applicationSession(auth, headers)).user;
	}

	function request<T>(
		headers: Headers,
		operation: (actor: Actor) => Promise<T>,
	) {
		return result(async () => operation(await currentUser(headers)));
	}

	return {
		createInvitation: (
			headers: Headers,
			input: CreateInvitationInput,
			initiatingRequest?: Request,
		) =>
			request(headers, () =>
				invitations.createInvitation(auth, headers, input, initiatingRequest),
			),
		listInvitations: (headers: Headers, organizationId: string) =>
			request(headers, () =>
				invitations.listInvitations(auth, headers, organizationId),
			),
		cancelInvitation: (
			headers: Headers,
			reference: OrganizationInvitationReference,
		) =>
			request(headers, (actor) =>
				invitations.cancelInvitation(database, auth, headers, actor, reference),
			),
		inspectInvitation: (headers: Headers, reference: InvitationReference) =>
			request(headers, () =>
				invitations.inspectInvitation(auth, headers, reference),
			),
		acceptInvitation: (headers: Headers, reference: InvitationReference) =>
			request(headers, () =>
				invitations.acceptInvitation(auth, headers, reference),
			),
		rejectInvitation: (headers: Headers, reference: InvitationReference) =>
			request(headers, () =>
				invitations.rejectInvitation(auth, headers, reference),
			),
		listOrganizationMembers: (headers: Headers, organizationId: string) =>
			request(headers, (actor) =>
				members.listMembers(database, auth, headers, actor, organizationId),
			),
		listProjectGrantCandidates: (
			headers: Headers,
			reference: ProjectReference,
		) =>
			request(headers, async (actor) => {
				await requireProject(database, actor, reference, "admin");
				return members.listMembers(
					database,
					auth,
					headers,
					actor,
					reference.organizationId,
				);
			}),
		updateOrganizationMemberRole: (headers: Headers, input: MemberRoleInput) =>
			request(headers, (actor) =>
				members.updateRole(database, auth, headers, actor, input),
			),
		removeOrganizationMember: (headers: Headers, input: MemberReference) =>
			request(headers, (actor) =>
				members.removeMember(database, auth, headers, actor, input),
			),
		leaveOrganization: (headers: Headers, organizationId: string) =>
			request(headers, (actor) =>
				members.leaveOrganization(
					database,
					auth,
					headers,
					actor,
					organizationId,
				),
			),
		listOrganizations: (headers: Headers) =>
			request(headers, (actor) =>
				organizations.listOrganizations(database, actor),
			),
		getOrganization: (headers: Headers, organizationId: string) =>
			request(headers, (actor) =>
				organizations.getOrganization(database, actor, organizationId),
			),
		createOrganization: (headers: Headers, input: OrganizationInput) =>
			request(headers, () =>
				organizations.createOrganization(auth, headers, input),
			),
		listProjects: (headers: Headers, organizationId: string) =>
			request(headers, (actor) =>
				projects.listProjects(database, actor, organizationId),
			),
		getProject: (headers: Headers, reference: ProjectReference) =>
			request(headers, (actor) =>
				projects.getProject(database, actor, reference),
			),
		createProject: (headers: Headers, input: CreateProjectInput) =>
			request(headers, (actor) =>
				projects.createProject(database, actor, input),
			),
		updateProject: (headers: Headers, input: UpdateProjectInput) =>
			request(headers, (actor) =>
				projects.updateProject(database, actor, input),
			),
		listProjectMembers: (headers: Headers, reference: ProjectReference) =>
			request(headers, (actor) =>
				projects.listProjectMembers(database, actor, reference),
			),
		setProjectMember: (headers: Headers, input: ProjectMembershipInput) =>
			request(headers, (actor) =>
				projects.setProjectMember(database, actor, input),
			),
		removeProjectMember: (
			headers: Headers,
			input: ProjectMembershipReference,
		) =>
			request(headers, (actor) =>
				projects.removeProjectMember(database, actor, input),
			),
		requireProjectAccess: async (
			headers: Headers,
			reference: ProjectReference,
			action: "read" | "admin" = "read",
		) =>
			requireProject(database, await currentUser(headers), reference, action),
	};
}
