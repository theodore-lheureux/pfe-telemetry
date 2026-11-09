import { inputMessage } from "./operation-message";

export function validationError(parse: () => unknown) {
	try {
		parse();
	} catch (error) {
		return inputMessage(error);
	}
}

export function validationMessages(error: unknown): string[] {
	if (typeof error === "string") return [error];
	if (Array.isArray(error)) return error.flatMap(validationMessages);
	if (!error || typeof error !== "object") return [];
	if ("message" in error) return validationMessages(error.message);
	return Object.values(error).flatMap(validationMessages);
}
