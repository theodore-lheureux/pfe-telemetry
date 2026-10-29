import type { OrganizationRole } from "./contracts";
import { parseIdentifier, parseOrganizationReference } from "./validation";

export interface MemberSummary {
	id: string;
	userId: string;
	name: string;
	email: string;
	role: OrganizationRole;
}

export interface MemberReference {
	organizationId: string;
	memberId: string;
}

export interface MemberRoleInput extends MemberReference {
	role: OrganizationRole;
}

export function parseMemberReference(value: unknown): MemberReference {
	const reference = parseOrganizationReference(value);
	return {
		...reference,
		memberId: parseIdentifier((value as Record<string, unknown>).memberId),
	};
}

export function parseMemberRole(value: unknown): MemberRoleInput {
	const reference = parseMemberReference(value);
	const role = (value as Record<string, unknown>).role;
	if (role !== "owner" && role !== "admin" && role !== "member")
		throw new Error("Select an organization role");
	return { ...reference, role };
}
