import type { FailureReason } from "../organizations/contracts";

export class InputError extends Error {
	constructor(
		readonly reason: FailureReason,
		message: string,
	) {
		super(message);
	}
}
