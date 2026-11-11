import type { FailureReason } from "./operation-result";

export class InputError extends Error {
	constructor(
		readonly reason: FailureReason,
		message: string,
	) {
		super(message);
	}
}
