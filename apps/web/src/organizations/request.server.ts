import { APIError } from "better-auth/api";
import { getAuth } from "../auth/auth.server";
import type { createAuth } from "../auth/create-auth.server";
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
import * as organizations from "./organizations.server";
import * as projects from "./projects.server";

type Database = ReturnType<typeof getDatabase>;
type Auth = ReturnType<typeof createAuth>;

function postgresCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return;
	if ("code" in error && typeof error.code === "string") return error.code;
	return "cause" in error ? postgresCode(error.cause) : undefined;
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
				error: { code: error.code, message: error.message },
			};
		if (postgresCode(error) === "23505")
			return {
				data: null,
				error: {
					code: "CONFLICT",
					message: "This slug or membership is already in use",
				},
			};
		if (error instanceof APIError) {
			if (error.statusCode >= 500) throw error;
			const statusCodes: Partial<Record<number, OperationErrorCode>> = {
				401: "UNAUTHENTICATED",
				403: "FORBIDDEN",
				404: "NOT_FOUND",
				409: "CONFLICT",
			};
			const duplicate = [
				"ORGANIZATION_SLUG_ALREADY_TAKEN",
				"ORGANIZATION_ALREADY_EXISTS",
			].includes(error.body?.code ?? "");
			return {
				data: null,
				error: {
					code: duplicate
						? "CONFLICT"
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
		const session = await auth.api.getSession({ headers });
		if (!session)
			throw new OperationError("UNAUTHENTICATED", "Sign in to continue");
		if (!session.user.emailVerified)
			throw new OperationError("FORBIDDEN", "Verify your email to continue");
		return session.user;
	}

	function request<T>(
		headers: Headers,
		operation: (actor: Actor) => Promise<T>,
	) {
		return result(async () => operation(await currentUser(headers)));
	}

	return {
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
