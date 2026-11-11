import { decodeCalendarTimestamp } from "../lib/calendar";
import { parseName, parseRequestId } from "../lib/input";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import type {
	CreateExecutionInput,
	ExecutionReference,
	TelemetryInput,
} from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}
function uuid(value: unknown) {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		throw new Error("Invalid identifier");
	return value.toLowerCase();
}
export function parseTimestamp(value: unknown) {
	const decoded = decodeCalendarTimestamp(value);
	if (decoded.error === "syntax")
		throw new InputError(
			"INVALID_TIME_RANGE",
			"Use an ISO timestamp with timezone",
		);
	if (decoded.error || decoded.time < 0 || decoded.time >= Date.UTC(2101, 0, 1))
		throw new InputError("INVALID_TIME_RANGE", "Invalid calendar timestamp");
	return new Date(decoded.time).toISOString();
}
export function parseExecutionReference(value: unknown): ExecutionReference {
	return {
		...parseProjectReference(value),
		executionId: uuid(record(value).executionId),
	};
}
export function parseExecutionList(value: unknown) {
	const input = record(value);
	return {
		...parseProjectReference(value),
		...(input.beforeId == null ? {} : { beforeId: uuid(input.beforeId) }),
	};
}
export function parseCreateExecution(value: unknown): CreateExecutionInput {
	const input = record(value);
	const startedAt = parseTimestamp(input.startedAt);
	const endedAt = parseTimestamp(input.endedAt);
	const duration = Date.parse(endedAt) - Date.parse(startedAt);
	if (duration <= 0 || duration > 7 * 86400000)
		throw new InputError(
			"INVALID_EXECUTION_WINDOW",
			"Execution window must be positive and at most seven days",
		);
	const hostId =
		input.hostId === "" || input.hostId == null ? null : input.hostId;
	if (
		hostId !== null &&
		(typeof hostId !== "string" ||
			new TextEncoder().encode(hostId).length > 128 ||
			/[\p{Cc}\p{Cs}]/u.test(hostId))
	)
		throw new InputError("INVALID_IDENTIFIER", "Invalid host identifier");
	return {
		...parseProjectReference(value),
		name: parseName(input.name),
		requestId: parseRequestId(input.requestId),
		nodeId: uuid(input.nodeId),
		hostId,
		startedAt,
		endedAt,
	};
}
export function parseUpdateExecution(value: unknown) {
	return {
		...parseExecutionReference(value),
		name: parseName(record(value).name),
	};
}
export function parseTelemetryInput(value: unknown): TelemetryInput {
	const input = record(value);
	const buckets = input.buckets ?? 300;
	if (
		typeof buckets !== "number" ||
		!Number.isInteger(buckets) ||
		buckets < 1 ||
		buckets > 600
	)
		throw new InputError("INVALID_TIME_RANGE", "Invalid chart resolution");
	return {
		...parseExecutionReference(value),
		buckets,
		...(input.from == null ? {} : { from: parseTimestamp(input.from) }),
		...(input.to == null ? {} : { to: parseTimestamp(input.to) }),
	};
}
