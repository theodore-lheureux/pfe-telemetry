import type { OrganizationRole } from "./contracts";

export function isOrganizationGrantRole(
	value: unknown,
): value is OrganizationRole {
	return value === "owner" || value === "admin" || value === "member";
}
