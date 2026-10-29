import { parseName, parseProjectReference } from "../organizations/validation";
import type {
	CollectorCredentialReference,
	CreateCollectorCredentialInput,
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
		throw new Error(
			"Source and host identifiers must contain 1–128 UTF-8 bytes without control characters",
		);
	return value;
}

function seconds(value: unknown, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > maximum
	)
		throw new Error(`Policy duration must be between 1 and ${maximum} seconds`);
	return value;
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

export function parseCreateCollectorCredentialInput(
	value: unknown,
): CreateCollectorCredentialInput {
	const input = record(value);
	if (!Array.isArray(input.hosts) || input.hosts.length > 256)
		throw new Error("Provide at most 256 permitted hosts");
	const hosts = input.hosts.map(identifier);
	if (new Set(hosts).size !== hosts.length)
		throw new Error("Permitted hosts must be unique");
	const requireHostId =
		input.requireHostId === undefined ? true : input.requireHostId;
	if (typeof requireHostId !== "boolean" || (requireHostId && !hosts.length))
		throw new Error("Host identification requires at least one permitted host");
	return {
		...parseProjectReference(value),
		name: parseName(input.name),
		sourceId: identifier(input.sourceId),
		hosts,
		requireHostId,
		maximumSubmissionAge: seconds(input.maximumSubmissionAge, 3600, 86400),
		allowedClockSkew: seconds(input.allowedClockSkew, 60, 3600),
		expiresAt: expiration(input.expiresAt),
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
