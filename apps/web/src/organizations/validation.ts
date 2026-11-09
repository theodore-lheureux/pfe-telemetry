import { InputError } from "../lib/input-error";
import type {
	CreateProjectInput,
	OrganizationInput,
	ProjectMembershipInput,
	ProjectReference,
	UpdateProjectInput,
} from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}

export function parseIdentifier(value: unknown) {
	if (typeof value !== "string" || !value || value.length > 128)
		throw new Error("Invalid identifier");
	return value;
}

export function parseName(value: unknown) {
	if (typeof value !== "string" || !value.trim() || value.trim().length > 120)
		throw new InputError("INVALID_NAME", "Name must contain 1–120 characters");
	return value.trim();
}

export function parseOrganizationInput(value: unknown): OrganizationInput {
	const input = record(value);
	return { name: parseName(input.name), slug: parseSlug(input.slug) };
}

export function parseSlug(value: unknown) {
	if (
		typeof value !== "string" ||
		value.length > 63 ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
	)
		throw new Error(
			"Slug must use lowercase letters, numbers and single hyphens, up to 63 characters",
		);
	return value;
}

export function parseOrganizationReference(value: unknown) {
	return { organizationId: parseIdentifier(record(value).organizationId) };
}

export function parseCreateProjectInput(value: unknown): CreateProjectInput {
	return {
		requestId: parseRequestId(record(value).requestId),
		...parseOrganizationInput(value),
		...parseOrganizationReference(value),
	};
}

export function parseRequestId(value: unknown) {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		throw new Error("Invalid request identifier");
	return value.toLowerCase();
}

export function parseProjectReference(value: unknown): ProjectReference {
	const input = record(value);
	if (
		typeof input.projectId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			input.projectId,
		)
	)
		throw new Error("Invalid project identifier");
	return {
		...parseOrganizationReference(value),
		projectId: input.projectId.toLowerCase(),
	};
}

export function parseUpdateProjectInput(value: unknown): UpdateProjectInput {
	return {
		...parseProjectReference(value),
		name: parseName(record(value).name),
	};
}

export function parseProjectMembershipInput(
	value: unknown,
): ProjectMembershipInput {
	const input = record(value);
	if (
		input.role !== "viewer" &&
		input.role !== "member" &&
		input.role !== "admin"
	)
		throw new Error("Invalid project role");
	return {
		...parseProjectReference(value),
		memberId: parseIdentifier(input.memberId),
		role: input.role,
	};
}

export function parseProjectMembershipReference(value: unknown) {
	return {
		...parseProjectReference(value),
		memberId: parseIdentifier(record(value).memberId),
	};
}
