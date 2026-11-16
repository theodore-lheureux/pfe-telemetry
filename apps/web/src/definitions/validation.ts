import { isFieldKey } from "../analytics/fields";
import { parseTags } from "../analytics/saved-insights-validation";
import { parseField, parseMetricName } from "../analytics/validation";
import { InputError } from "../lib/input-error";
import { parseProjectReference } from "../organizations/validation";
import {
	type AnnotationInput,
	ATTRIBUTE_SCOPES,
	type AttributeReference,
	type AttributeScope,
	DEFINITION_STATUSES,
	type DefinitionStatus,
	MAX_DEFINITION_DESCRIPTION,
	type MetricReference,
	type UpdateAttributeInput,
	type UpdateMetricInput,
} from "./contracts";

function record(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InputError("INVALID_QUERY", "Invalid request");
	return value as Record<string, unknown>;
}

export function parseMetricReference(value: unknown): MetricReference {
	return {
		...parseProjectReference(value),
		metric: parseMetricName(record(value).metric),
	};
}

export function parseAttributeReference(value: unknown): AttributeReference {
	const { scope, key } = record(value);
	if (!(ATTRIBUTE_SCOPES as readonly unknown[]).includes(scope))
		throw new InputError("INVALID_QUERY", "Invalid attribute scope");
	if (typeof key !== "string" || !isFieldKey(key))
		throw new InputError("INVALID_QUERY", "Invalid attribute");
	return {
		...parseProjectReference(value),
		scope: scope as AttributeScope,
		key,
	};
}

function parseAnnotation(input: Record<string, unknown>): AnnotationInput {
	const { description, status } = input;
	if (
		typeof description !== "string" ||
		description.trim().length > MAX_DEFINITION_DESCRIPTION
	)
		throw new InputError("INVALID_QUERY", "Invalid description");
	if (
		status !== null &&
		!(DEFINITION_STATUSES as readonly unknown[]).includes(status)
	)
		throw new InputError("INVALID_QUERY", "Invalid status");
	return {
		description: description.trim(),
		tags: parseTags(input.tags),
		status: status as DefinitionStatus | null,
	};
}

function nullableText(value: unknown, what: string) {
	if (value === null) return null;
	if (typeof value !== "string" || !value || value.length > 300)
		throw new InputError("INVALID_QUERY", `Invalid ${what}`);
	return value;
}

export function parseUpdateMetric(value: unknown): UpdateMetricInput {
	const input = record(value);
	const defaultBreakdown = nullableText(
		input.defaultBreakdown,
		"default breakdown",
	);
	// Any field an insight can be broken down by: a core field or an attribute.
	if (defaultBreakdown !== null) parseField(defaultBreakdown);
	return {
		...parseMetricReference(value),
		...parseAnnotation(input),
		ownerId: nullableText(input.ownerId, "owner"),
		defaultBreakdown,
	};
}

export function parseUpdateAttribute(value: unknown): UpdateAttributeInput {
	return {
		...parseAttributeReference(value),
		...parseAnnotation(record(value)),
	};
}
