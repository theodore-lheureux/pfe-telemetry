import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import type { createAuth } from "../auth/create-auth.server";
import type { getDatabase } from "../db/client.server";
import { invitation } from "../db/schema";
import { type Actor, requireOrganization } from "./access.server";
import { OperationError } from "./errors";
import type {
	CreateInvitationInput,
	InvitationDetails,
	InvitationReference,
	InvitationSummary,
	OrganizationInvitationReference,
} from "./invitation-contracts";
import { parseInvitationRole } from "./invitation-validation";

type Auth = ReturnType<typeof createAuth>;
type Database = ReturnType<typeof getDatabase>;

function summary(entry: {
	id: string;
	organizationId: string;
	email: string;
	role?: string | null;
	status: string;
	expiresAt: Date;
	createdAt: Date;
	inviterId: string;
}): InvitationSummary {
	return {
		id: entry.id,
		organizationId: entry.organizationId,
		email: entry.email,
		role: parseInvitationRole(entry.role),
		status: entry.status,
		expiresAt: entry.expiresAt,
		createdAt: entry.createdAt,
		inviterId: entry.inviterId,
	};
}

export async function createInvitation(
	auth: Auth,
	headers: Headers,
	input: CreateInvitationInput,
	request?: Request,
) {
	return summary(
		await auth.api.createInvitation({
			headers,
			body: input,
			request,
			asResponse: false,
		}),
	);
}

export async function listInvitations(
	auth: Auth,
	headers: Headers,
	organizationId: string,
) {
	const entries = await auth.api.listInvitations({
		headers,
		query: { organizationId },
	});
	return entries.map(summary);
}

export async function cancelInvitation(
	database: Database,
	auth: Auth,
	headers: Headers,
	actor: Actor,
	reference: OrganizationInvitationReference,
) {
	await requireOrganization(database, actor, reference.organizationId);
	const [entry] = await database
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				eq(invitation.id, reference.invitationId),
				eq(invitation.organizationId, reference.organizationId),
			),
		);
	if (!entry) throw new OperationError("NOT_FOUND", "Invitation not found");
	const canceled = await auth.api.cancelInvitation({
		headers,
		body: { invitationId: entry.id },
	});
	if (!canceled) throw new OperationError("NOT_FOUND", "Invitation not found");
	return summary(canceled);
}

export async function inspectInvitation(
	auth: Auth,
	headers: Headers,
	reference: InvitationReference,
): Promise<InvitationDetails> {
	const entry = await auth.api
		.getInvitation({
			headers,
			query: { id: reference.invitationId },
		})
		.catch((error: unknown) => {
			// Native inspection uses uncoded 400s for unavailable invitation links.
			if (error instanceof APIError && error.statusCode === 400)
				throw new OperationError("NOT_FOUND", "Invitation is unavailable");
			throw error;
		});
	return {
		...summary(entry),
		organizationName: entry.organizationName,
		organizationSlug: entry.organizationSlug,
		inviterEmail: entry.inviterEmail,
	};
}

export async function acceptInvitation(
	auth: Auth,
	headers: Headers,
	reference: InvitationReference,
) {
	const accepted = await auth.api.acceptInvitation({
		headers,
		body: reference,
	});
	return {
		organizationId: accepted.member.organizationId,
		memberId: accepted.member.id,
	};
}

export async function rejectInvitation(
	auth: Auth,
	headers: Headers,
	reference: InvitationReference,
) {
	await auth.api.rejectInvitation({ headers, body: reference });
	return { invitationId: reference.invitationId };
}
