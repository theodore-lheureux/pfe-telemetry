import { randomUUID } from "node:crypto";
import { actorService } from "../src/auth/actor.server";
import type { createAuth } from "../src/auth/create-auth.server";
import type { OperationErrorCode } from "../src/lib/operation-error";
import type { OperationResult } from "../src/lib/operation-result";
import type { ProjectRole } from "../src/organizations/contracts";
import * as organizations from "../src/organizations/organizations.server";
import * as projects from "../src/organizations/projects.server";
import { trustedActor } from "./auth-actors";
import type { createTestDatabase } from "./database";

/** The access level an operation requires, as checked by `requireProject`. */
export type ProjectAccess = "read" | "write" | "admin";

/** Every actor class of the project access policy, and the access it grants. */
export const PROJECT_ROLE_MATRIX = {
	"organization owner": { read: true, write: true, admin: true },
	"organization admin": { read: true, write: true, admin: true },
	"organization member without project role": {
		read: false,
		write: false,
		admin: false,
	},
	"project viewer": { read: true, write: false, admin: false },
	"project member": { read: true, write: true, admin: false },
	"project admin": { read: true, write: true, admin: true },
	outsider: { read: false, write: false, admin: false },
	unauthenticated: { read: false, write: false, admin: false },
} satisfies Record<string, Record<ProjectAccess, boolean>>;

export type ProjectActorRole = keyof typeof PROJECT_ROLE_MATRIX;
export const PROJECT_ACTOR_ROLES = Object.keys(
	PROJECT_ROLE_MATRIX,
) as ProjectActorRole[];

/** The error an operation returns to this actor, or null when it is allowed. */
export function expectedProjectError(
	role: ProjectActorRole,
	access: ProjectAccess,
): OperationErrorCode | null {
	if (role === "unauthenticated") return "UNAUTHENTICATED";
	if (PROJECT_ROLE_MATRIX[role][access]) return null;
	// Actors who cannot read the project must not learn that it exists.
	return PROJECT_ROLE_MATRIX[role].read ? "FORBIDDEN" : "NOT_FOUND";
}

function data<T>(result: OperationResult<T>): T {
	if (result.error) throw new Error(result.error.message);
	return result.data;
}

/**
 * One organization with a private project, a sibling project and a separate
 * organization's project, plus a signed-in actor for every policy role.
 */
export async function projectRoleScenario(
	auth: ReturnType<typeof createAuth>,
	database: Awaited<ReturnType<typeof createTestDatabase>>,
	readCode: (email: string) => string | undefined,
	origin: string,
) {
	const requests = actorService(auth);
	const signIn = () =>
		trustedActor(
			auth,
			`${randomUUID()}@example.invalid`,
			readCode,
			new Headers({ origin }),
		);
	const owner = await signIn();
	const outsider = await signIn();
	const createProject = async (
		headers: Headers,
		organizationId: string,
		name: string,
	) =>
		data(
			await requests(headers, (actor) =>
				projects.createProject(database.db, actor, {
					requestId: randomUUID(),
					organizationId,
					name,
				}),
			),
		);
	const createOrganization = async (headers: Headers, name: string) =>
		data(
			await requests(headers, () =>
				organizations.createOrganization(auth, headers, {
					name,
					slug: `${name.toLowerCase()}-${randomUUID()}`,
				}),
			),
		);
	const organization = await createOrganization(owner.headers, "Access");
	const project = await createProject(
		owner.headers,
		organization.id,
		"Private",
	);
	const sibling = await createProject(
		owner.headers,
		organization.id,
		"Sibling",
	);
	const foreignOrganization = await createOrganization(
		outsider.headers,
		"Foreign",
	);
	const foreign = await createProject(
		outsider.headers,
		foreignOrganization.id,
		"Foreign",
	);
	const reference = { organizationId: organization.id, projectId: project.id };
	const join = async (role: "admin" | "member", projectRole?: ProjectRole) => {
		const actor = await signIn();
		const membership = await auth.api.addMember({
			body: { organizationId: organization.id, userId: actor.id, role },
		});
		if (projectRole)
			data(
				await requests(owner.headers, (current) =>
					projects.setProjectMember(database.db, current, {
						...reference,
						memberId: membership.id,
						role: projectRole,
					}),
				),
			);
		return actor;
	};
	const actors: Record<ProjectActorRole, { headers: Headers }> = {
		"organization owner": owner,
		"organization admin": await join("admin"),
		"organization member without project role": await join("member"),
		"project viewer": await join("member", "viewer"),
		"project member": await join("member", "member"),
		"project admin": await join("member", "admin"),
		outsider,
		unauthenticated: { headers: new Headers({ origin }) },
	};
	return {
		actors,
		reference,
		/** References an authorized actor could substitute for the project. */
		substitutes: {
			"sibling project": {
				organizationId: organization.id,
				projectId: sibling.id,
			},
			"foreign project": {
				organizationId: foreignOrganization.id,
				projectId: foreign.id,
			},
			"foreign project in own organization": {
				organizationId: organization.id,
				projectId: foreign.id,
			},
			"own project in foreign organization": {
				organizationId: foreignOrganization.id,
				projectId: project.id,
			},
		},
		requests,
	};
}
