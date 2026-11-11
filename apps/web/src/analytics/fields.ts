import type { AttributeDefinition } from "./contracts";

// The semantic model's attribute field syntax: `attributes["key"]` for point attributes
// and `resource.attributes["key"]` for resource attributes. Keys with quotes, backslashes
// or control characters are excluded so every field has one unambiguous spelling.

export type AttributeScope = AttributeDefinition["scope"];

const KEY = /^[^"\\\p{Cc}]{1,256}$/u;
const FIELD = /^(resource\.)?attributes\["([^"\\\p{Cc}]{1,256})"\]$/u;

/** Whether an attribute key can be written as a field. */
export function isFieldKey(key: string) {
	return KEY.test(key);
}

export function attributeField(scope: AttributeScope, key: string) {
	return `${scope === "resource" ? "resource." : ""}attributes["${key}"]`;
}

/** The scope and key of an attribute field, or null for any other text. */
export function parseAttributeField(
	field: string,
): { scope: AttributeScope; key: string } | null {
	const match = FIELD.exec(field);
	return match?.[2]
		? { scope: match[1] ? "resource" : "point", key: match[2] }
		: null;
}
