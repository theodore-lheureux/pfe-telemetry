export type OrganizationRole = "owner" | "admin" | "member";
export type ProjectRole = "viewer" | "member" | "admin";
export type FailureReason =
	| "REQUEST_ID_REUSED"
	| "LAST_OWNER"
	| "VERIFIED_EMAIL_REQUIRED"
	| "INVALID_TIME_RANGE"
	| "INVALID_EXECUTION_WINDOW"
	| "INVALID_EXPIRY"
	| "INVALID_NAME"
	| "HOSTS_REQUIRED"
	| "HOSTS_UNIQUE"
	| "INVALID_IDENTIFIER"
	| "CREDENTIAL_INACTIVE";

export interface OrganizationSummary {
	id: string;
	name: string;
	slug: string;
	role: OrganizationRole;
	logo?: string | null;
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
	requestId: string;
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
					| "SESSION_NOT_FRESH"
					| "FORBIDDEN"
					| "NOT_FOUND"
					| "INVALID_INPUT"
					| "CONFLICT"
					| "RATE_LIMITED"
					| "UNAVAILABLE"
					| "CAPACITY"
					| "TIMEOUT"
					| "CANCELLED";
				message: string;
				reason?: FailureReason;
			};
	  };
