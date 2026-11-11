export type OrganizationRole = "owner" | "admin" | "member";
export type ProjectRole = "viewer" | "member" | "admin";

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
	role: ProjectRole;
	tags: string[];
	projectGroup: string;
	timeZone: string;
	weekStartsOn: number;
}

export type ProjectCustomizationChange =
	| { action: "add-tag"; tag: string }
	| { action: "remove-tag"; tag: string }
	| { action: "group"; projectGroup: string }
	| { action: "time-zone"; timeZone: string }
	| { action: "week-start"; weekStartsOn: number };

export type ProjectCustomizationInput = ProjectReference &
	ProjectCustomizationChange;

export interface OrganizationInput {
	name: string;
	slug: string;
}

export interface CreateProjectInput {
	name: string;
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
