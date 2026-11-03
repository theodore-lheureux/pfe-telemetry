export type OrganizationRole = "owner" | "admin" | "member";
export type ProjectRole = "viewer" | "member" | "admin";

export interface OrganizationSummary {
	id: string;
	name: string;
	slug: string;
	role: OrganizationRole;
}

export interface ProjectSummary {
	id: string;
	organizationId: string;
	name: string;
	slug: string;
	role: ProjectRole;
}

export interface OrganizationInput {
	name: string;
	slug: string;
}

export interface CreateProjectInput extends OrganizationInput {
	organizationId: string;
}

export interface ProjectReference {
	organizationId: string;
	projectId: string;
}

export interface UpdateProjectInput extends ProjectReference {
	name: string;
}

export interface ProjectMembershipReference extends ProjectReference {
	memberId: string;
}

export interface ProjectMembershipInput extends ProjectMembershipReference {
	role: ProjectRole;
}

export interface ProjectMembershipSummary {
	projectId: string;
	memberId: string;
	userId: string;
	role: ProjectRole;
}

export type OperationResult<T> =
	| { data: T; error: null }
	| {
			data: null;
			error: {
				code:
					| "UNAUTHENTICATED"
					| "FORBIDDEN"
					| "NOT_FOUND"
					| "INVALID_INPUT"
					| "CONFLICT";
				message: string;
			};
	  };
