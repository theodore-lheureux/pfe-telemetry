import { parseProjectReference } from "../organizations/validation";
import type {
	ExecutionMeasurementsInput,
	ExecutionReference,
} from "./contracts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	return value as Record<string, unknown>;
}
export function parseExecutionKey(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim() !== value ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
	)
		throw new Error("Invalid execution key");
	return value;
}
export function parseExecutionReference(value: unknown): ExecutionReference {
	return {
		...parseProjectReference(value),
		executionKey: parseExecutionKey(record(value).executionKey),
	};
}
export function parseExecutionList(value: unknown) {
	const input = record(value);
	return {
		...parseProjectReference(value),
		...(input.afterKey == null
			? {}
			: { afterKey: parseExecutionKey(input.afterKey) }),
	};
}
export function parseNodeId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
	)
		throw new Error("Invalid node");
	return value;
}
export function parseExecutionMeasurements(
	value: unknown,
): ExecutionMeasurementsInput {
	const input = record(value);
	return {
		...parseExecutionReference(value),
		...(input.node == null ? {} : { node: parseNodeId(input.node) }),
	};
}
