import { InputError } from "../lib/input-error";
import { parseName, parseProjectReference } from "../organizations/validation";
import {
	type CollectorCredentialReference,
	type CreateCollectorCredentialInput,
	MAX_U64_DURATION_NANOSECONDS,
	MAX_U64_NANOSECONDS_DURATION_SECONDS,
	NANOSECONDS_PER_SECOND,
	type RootGrantInput,
} from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		new TextEncoder().encode(value).length > 128 ||
		/[\p{Cc}\p{Cs}]/u.test(value)
	)
		throw new InputError(
			"INVALID_IDENTIFIER",
			"Source and resource identifiers must contain 1–128 UTF-8 bytes without control characters",
		);
	return value;
}

function seconds(value: unknown, fallback: number, minimum: number): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > MAX_U64_NANOSECONDS_DURATION_SECONDS
	)
		throw new Error("Policy duration exceeds the UInt64 nanosecond range");
	return value;
}

function resource(value: unknown) {
	const input = record(value);
	const resourceId = identifier(input.resourceId);
	if (resourceId.startsWith("recount.local."))
		throw new InputError(
			"INVALID_IDENTIFIER",
			"Local resource namespace is reserved",
		);
	const resourceKind = input.resourceKind;
	if (
		typeof resourceKind !== "number" ||
		!Number.isInteger(resourceKind) ||
		resourceKind < 0 ||
		resourceKind > 8
	)
		throw new Error("Invalid resource kind");
	return { resourceId, resourceKind };
}

function root(value: unknown): RootGrantInput {
	const input = record(value);
	const reference = resource(value);
	const adapter = input.adapter ?? "standard";
	if (adapter !== "standard" && adapter !== "linux")
		throw new Error("Invalid resource adapter");
	const kinds = input.allowedLocalKinds ?? [];
	if (
		!Array.isArray(kinds) ||
		kinds.length > 5 ||
		kinds.some((kind) => ![2, 3, 4, 6, 8].includes(kind)) ||
		new Set(kinds).size !== kinds.length ||
		(adapter === "standard" && kinds.length > 0)
	)
		throw new Error("Invalid root-local kinds");
	return { ...reference, adapter, allowedLocalKinds: kinds as number[] };
}

function grants<T extends { resourceId: string }>(
	value: unknown,
	parse: (value: unknown) => T,
): T[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 256)
		throw new Error("Grant operation exceeds its bounded size");
	const result = value.map(parse);
	if (new Set(result.map((entry) => entry.resourceId)).size !== result.length)
		throw new Error("Resource grants must be unique");
	return result;
}

function expiration(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const parts =
		typeof value === "string"
			? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
					value,
				)
			: null;
	if (!parts)
		throw new Error("Expiration must be an ISO timestamp with a timezone");
	const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		!Number.isFinite(Date.parse(parts[0]))
	)
		throw new Error("Expiration must be a valid calendar timestamp");
	return new Date(parts[0]).toISOString();
}

export function parseCollectorCredentialValues(value: unknown) {
	const input = record(value);
	const primary = root({
		resourceId: input.rootId,
		resourceKind: input.rootKind ?? 1,
		adapter: input.adapter,
		allowedLocalKinds: input.allowedLocalKinds,
	});
	const additionalRoots = grants(input.additionalRoots, root);
	const resources = grants(input.resources, resource);
	if (additionalRoots.some((grant) => grant.resourceId === primary.resourceId))
		throw new Error("Default root grant must be unique");
	const rootIds = new Set([
		primary.resourceId,
		...additionalRoots.map((grant) => grant.resourceId),
	]);
	if (resources.some((grant) => rootIds.has(grant.resourceId)))
		throw new Error(
			"Root and independent grants must have distinct identities",
		);
	const maximumSubmissionAge = seconds(input.maximumSubmissionAge, 3600, 1);
	const allowedClockSkew = seconds(input.allowedClockSkew, 60, 0);
	if (
		(BigInt(maximumSubmissionAge) + BigInt(allowedClockSkew)) *
			NANOSECONDS_PER_SECOND >
		MAX_U64_DURATION_NANOSECONDS
	)
		throw new Error("Upload age plus skew exceeds UInt64 nanoseconds");
	return {
		name: parseName(input.name),
		sourceId: identifier(input.sourceId),
		rootId: primary.resourceId,
		rootKind: primary.resourceKind,
		adapter: primary.adapter,
		allowedLocalKinds: primary.allowedLocalKinds,
		additionalRoots,
		resources,
		maximumSubmissionAge,
		allowedClockSkew,
		expiresAt: expiration(input.expiresAt),
	};
}

export function parseCreateCollectorCredentialInput(
	value: unknown,
): CreateCollectorCredentialInput {
	return {
		...parseProjectReference(value),
		...parseCollectorCredentialValues(value),
	};
}

export function parseCollectorCredentialReference(
	value: unknown,
): CollectorCredentialReference {
	const input = record(value);
	if (
		typeof input.credentialId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			input.credentialId,
		)
	)
		throw new Error("Invalid credential identifier");
	return { ...parseProjectReference(value), credentialId: input.credentialId };
}
