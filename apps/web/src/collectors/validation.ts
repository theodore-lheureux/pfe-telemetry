import { parseName } from "../lib/input";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	type CollectorAdapter,
	type CreateEnrollmentKeyInput,
	DEFAULT_LINUX_LOCAL_KINDS,
	type EnrollmentKeyReference,
	type EnrollNodeInput,
	type ListNodesInput,
	LOCAL_KINDS,
	MAX_NODES_PER_REQUEST,
	MAX_U64_NANOSECONDS_DURATION_SECONDS,
	type NodesReference,
	type NodeTokenInput,
} from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENROLLMENT_KEY =
	/^recount_enroll_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}

function uuid(value: unknown) {
	if (typeof value !== "string" || !UUID.test(value))
		throw new Error("Invalid identifier");
	return value.toLowerCase();
}

export function parseMachineId(value: unknown) {
	if (
		typeof value !== "string" ||
		!value ||
		new TextEncoder().encode(value).length > 128 ||
		/[\p{Cc}\p{Cs}]/u.test(value) ||
		value.startsWith("recount.local.")
	)
		throw new InputError(
			"INVALID_IDENTIFIER",
			"Machine IDs must contain 1–128 UTF-8 bytes without control characters",
		);
	return value;
}

function seconds(value: unknown, fallback: number, minimum: number) {
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

function labels(value: unknown) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 20)
		throw new Error("At most 20 labels");
	const parsed = value.map((label) => {
		if (typeof label !== "string") throw new Error("Invalid label");
		const trimmed = label.trim();
		if (!trimmed || trimmed.length > 40 || /[\p{Cc}]/u.test(trimmed))
			throw new InputError(
				"INVALID_IDENTIFIER",
				"Labels must contain 1–40 characters",
			);
		return trimmed;
	});
	return [...new Set(parsed)];
}

export function parseCreateEnrollmentKeyInput(value: unknown) {
	const input = record(value);
	const adapter: CollectorAdapter =
		input.adapter === undefined ? "linux" : (input.adapter as CollectorAdapter);
	if (adapter !== "linux" && adapter !== "standard")
		throw new Error("Invalid adapter");
	const kinds =
		input.allowedLocalKinds === undefined
			? adapter === "linux"
				? DEFAULT_LINUX_LOCAL_KINDS
				: []
			: input.allowedLocalKinds;
	if (
		!Array.isArray(kinds) ||
		kinds.some((kind) => !(LOCAL_KINDS as readonly unknown[]).includes(kind)) ||
		new Set(kinds).size !== kinds.length ||
		(adapter === "standard" && kinds.length)
	)
		throw new Error("Invalid local resource kinds");
	const maximumSubmissionAge = seconds(input.maximumSubmissionAge, 3600, 1);
	const allowedClockSkew = seconds(input.allowedClockSkew, 60, 0);
	if (
		maximumSubmissionAge + allowedClockSkew >
		MAX_U64_NANOSECONDS_DURATION_SECONDS
	)
		throw new Error("Policy duration exceeds the UInt64 nanosecond range");
	const maxNodes = input.maxNodes ?? null;
	if (
		maxNodes !== null &&
		(typeof maxNodes !== "number" ||
			!Number.isInteger(maxNodes) ||
			maxNodes < 1 ||
			maxNodes > 1_000_000)
	)
		throw new Error("Invalid node limit");
	const expiresAt = input.expiresAt ?? null;
	if (
		expiresAt !== null &&
		(typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))
	)
		throw new Error("Invalid expiry");
	return {
		...parseProjectReference(value),
		name: parseName(input.name),
		adapter,
		allowedLocalKinds: [...(kinds as number[])].sort((a, b) => a - b),
		maximumSubmissionAge,
		allowedClockSkew,
		maxNodes,
		labels: labels(input.labels),
		expiresAt,
	} satisfies Required<CreateEnrollmentKeyInput>;
}

export function parseEnrollmentKeyReference(
	value: unknown,
): EnrollmentKeyReference {
	return {
		...parseProjectReference(value),
		enrollmentKeyId: uuid(record(value).enrollmentKeyId),
	};
}

export function parseListNodesInput(value: unknown): Required<ListNodesInput> {
	const input = record(value);
	const status = input.status ?? "active";
	if (status !== "active" && status !== "revoked" && status !== "all")
		throw new Error("Invalid status");
	const page = input.page ?? 1;
	if (typeof page !== "number" || !Number.isInteger(page) || page < 1)
		throw new Error("Invalid page");
	const query = input.query ?? "";
	if (typeof query !== "string" || query.length > 200)
		throw new Error("Invalid search");
	return {
		...parseProjectReference(value),
		query: query.trim(),
		status,
		page,
	};
}

export function parseNodesReference(value: unknown): NodesReference {
	const ids = record(value).nodeIds;
	if (!Array.isArray(ids) || !ids.length || ids.length > MAX_NODES_PER_REQUEST)
		throw new Error(`Select 1–${MAX_NODES_PER_REQUEST} nodes`);
	return {
		...parseProjectReference(value),
		nodeIds: [...new Set(ids.map(uuid))],
	};
}

export function parseEnrollNodeInput(
	value: unknown,
): Required<EnrollNodeInput> {
	const input = record(value);
	if (
		typeof input.enrollmentKey !== "string" ||
		!ENROLLMENT_KEY.test(input.enrollmentKey)
	)
		throw new InputError("INVALID_IDENTIFIER", "Invalid enrollment key");
	const hostname =
		typeof input.hostname === "string" ? input.hostname.trim() : "";
	if (!hostname || hostname.length > 255 || /[\p{Cc}]/u.test(hostname))
		throw new InputError("INVALID_IDENTIFIER", "Invalid hostname");
	if (
		typeof input.publicKey !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.publicKey)
	)
		throw new InputError(
			"INVALID_IDENTIFIER",
			"Public key must be a base64url Ed25519 key",
		);
	const version = input.collectorVersion ?? "";
	if (typeof version !== "string" || version.length > 64)
		throw new Error("Invalid collector version");
	return {
		enrollmentKey: input.enrollmentKey,
		machineId: parseMachineId(input.machineId),
		hostname,
		publicKey: input.publicKey,
		collectorVersion: version,
	};
}

export function parseNodeTokenInput(value: unknown): NodeTokenInput {
	const input = record(value);
	if (
		typeof input.timestamp !== "number" ||
		!Number.isSafeInteger(input.timestamp)
	)
		throw new Error("Invalid timestamp");
	if (
		typeof input.signature !== "string" ||
		!/^[A-Za-z0-9_-]{86}$/.test(input.signature)
	)
		throw new Error("Invalid signature");
	return {
		nodeId: uuid(input.nodeId),
		timestamp: input.timestamp,
		signature: input.signature,
	};
}
