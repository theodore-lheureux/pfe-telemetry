import type { OperationResult } from "../lib/operation-result";
import type { OrganizationRole } from "./contracts";

export const MAX_INVITATION_RECIPIENTS = 10;

export interface InvitationRecipientInput {
	clientId: string;
	email: string;
	role: OrganizationRole;
	recipientName?: string;
}

export interface CreateInvitationsInput {
	organizationId: string;
	recipients: InvitationRecipientInput[];
	message?: string;
}

export type InvitationBatchItem = { clientId: string; email: string } & (
	| { status: "created"; invitation: InvitationSummary }
	| { status: "rejected"; error: NonNullable<OperationResult<never>["error"]> }
	| { status: "not-attempted" }
);

export interface InvitationBatchResult {
	results: InvitationBatchItem[];
}

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
	recipientName?: string;
	message?: string;
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
	recipientName?: string;
	message?: string;
}

export interface InvitationDetails extends InvitationSummary {
	organizationName: string;
	organizationSlug: string;
	inviterEmail: string;
}
