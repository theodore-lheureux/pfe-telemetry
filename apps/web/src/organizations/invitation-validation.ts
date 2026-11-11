import { parseIdentifier } from "../lib/input";
import type {
	CreateInvitationInput,
	CreateInvitationsInput,
	InvitationReference,
	OrganizationInvitationReference,
} from "./invitation-contracts";
import { MAX_INVITATION_RECIPIENTS } from "./invitation-contracts";
import { isInvitationEmail } from "./invitation-email";
import { isOrganizationGrantRole } from "./roles";
import { parseOrganizationReference } from "./validation";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid invitation request");
	return value as Record<string, unknown>;
}

export function parseInvitationRole(value: unknown) {
	if (!isOrganizationGrantRole(value))
		throw new Error("Select one organization role: owner, admin or member");
	return value;
}

export function parseInvitationPersonalization(input: Record<string, unknown>) {
	const result: { recipientName?: string; message?: string } = {};
	for (const [key, limit] of [
		["recipientName", 100],
		["message", 2000],
	] as const) {
		const value = input[key];
		if (value === undefined || value === null) continue;
		if (
			typeof value !== "string" ||
			value.length > limit ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in email content while allowing message whitespace.
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
			(key === "recipientName" && /[\r\n]/.test(value))
		)
			throw new Error("Invalid invitation name or message");
		result[key] = value.trim();
	}
	return result;
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
		...parseInvitationPersonalization(input),
		email: input.email.trim().toLowerCase(),
		role: parseInvitationRole(input.role),
		...(input.resend === undefined ? {} : { resend: input.resend }),
	};
}

export function parseInvitationReference(value: unknown): InvitationReference {
	return { invitationId: parseIdentifier(record(value).invitationId) };
}

export function parseCreateInvitationsInput(
	value: unknown,
): CreateInvitationsInput {
	const input = record(value);
	const { organizationId } = parseOrganizationReference(value);
	if (
		!Array.isArray(input.recipients) ||
		input.recipients.length < 1 ||
		input.recipients.length > MAX_INVITATION_RECIPIENTS
	)
		throw new Error(
			`Invite between 1 and ${MAX_INVITATION_RECIPIENTS} recipients`,
		);
	const ids = new Set<string>();
	const emails = new Set<string>();
	const recipients = input.recipients.map((value) => {
		const row = record(value);
		const clientId = parseIdentifier(row.clientId);
		const parsed = parseCreateInvitationInput({
			organizationId,
			email: row.email,
			role: row.role,
			recipientName: row.recipientName,
		});
		if (!isInvitationEmail(parsed.email))
			throw new Error("Enter a valid email address");
		if (ids.has(clientId) || emails.has(parsed.email))
			throw new Error("Each invitation recipient must be unique");
		ids.add(clientId);
		emails.add(parsed.email);
		return {
			clientId,
			email: parsed.email,
			role: parsed.role,
			recipientName: parsed.recipientName,
		};
	});
	return {
		organizationId,
		recipients,
		...parseInvitationPersonalization({ message: input.message }),
	};
}

export function parseOrganizationInvitationReference(
	value: unknown,
): OrganizationInvitationReference {
	return {
		...parseOrganizationReference(value),
		...parseInvitationReference(value),
	};
}
