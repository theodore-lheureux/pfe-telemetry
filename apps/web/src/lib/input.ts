import { InputError } from "./input-error";

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
