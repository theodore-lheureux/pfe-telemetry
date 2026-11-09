import type { OrganizationRole } from "./contracts";

export interface InvitationReference {
	invitationId: string;
}

export interface OrganizationInvitationReference extends InvitationReference {
	organizationId: string;
}

export interface CreateInvitationInput {
	organizationId: string;
	email: string;
	role: OrganizationRole;
	resend?: boolean;
}

export interface InvitationSummary {
	id: string;
	organizationId: string;
	email: string;
	role: OrganizationRole;
	status: string;
	expiresAt: Date;
	createdAt: Date;
	inviterId: string;
}

export interface InvitationDetails extends InvitationSummary {
	organizationName: string;
	organizationSlug: string;
	inviterEmail: string;
}
