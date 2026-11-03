import { InputError } from "../lib/input-error";
import { parseName, parseProjectReference } from "../organizations/validation";
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
	const match =
		typeof value === "string" &&
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
			value,
		);
	if (!match)
		throw new InputError(
			"INVALID_TIME_RANGE",
			"Use an ISO timestamp with timezone",
		);
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const time = Date.parse(match[0]);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		!Number.isFinite(time) ||
		time < 0 ||
		time >= Date.UTC(2101, 0, 1)
	)
		throw new InputError("INVALID_TIME_RANGE", "Invalid calendar timestamp");
	return new Date(time).toISOString();
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
		credentialId: uuid(input.credentialId),
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
