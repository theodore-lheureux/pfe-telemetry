import type {
	CreateInvitationInput,
	InvitationReference,
	OrganizationInvitationReference,
} from "./invitation-contracts";
import { parseIdentifier, parseOrganizationReference } from "./validation";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid invitation request");
	return value as Record<string, unknown>;
}

export function parseInvitationRole(value: unknown) {
	if (value !== "owner" && value !== "admin" && value !== "member")
		throw new Error("Select one organization role: owner, admin or member");
	return value;
}

export function parseCreateInvitationInput(
	value: unknown,
): CreateInvitationInput {
	const input = record(value);
	if (
		typeof input.email !== "string" ||
		!input.email.trim() ||
		input.email.trim().length > 254 ||
		/[\r\n]/.test(input.email)
	)
		throw new Error("Enter a valid email address");
	if (input.resend !== undefined && typeof input.resend !== "boolean")
		throw new Error("Invalid resend option");
	return {
		...parseOrganizationReference(value),
		email: input.email.trim().toLowerCase(),
		role: parseInvitationRole(input.role),
		...(input.resend === undefined ? {} : { resend: input.resend }),
	};
}

export function parseInvitationReference(value: unknown): InvitationReference {
	return { invitationId: parseIdentifier(record(value).invitationId) };
}

export function parseOrganizationInvitationReference(
	value: unknown,
): OrganizationInvitationReference {
	return {
		...parseOrganizationReference(value),
		...parseInvitationReference(value),
	};
}
