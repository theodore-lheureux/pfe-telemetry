import type { OperationResult } from "./contracts";

export type OperationErrorCode = NonNullable<
	OperationResult<never>["error"]
>["code"];

export class OperationError extends Error {
	constructor(
		readonly code: OperationErrorCode,
		message: string,
	) {
		super(message);
	}
}
