export type FailureReason =
	| "REQUEST_ID_REUSED"
	| "LAST_OWNER"
	| "VERIFIED_EMAIL_REQUIRED"
	| "INVALID_TIME_RANGE"
	| "INVALID_EXECUTION_WINDOW"
	| "INVALID_EXPIRY"
	| "INVALID_NAME"
	| "INVALID_PROJECT_SETTING"
	| "INVALID_IDENTIFIER";

export type OperationResult<T> =
	| { data: T; error: null }
	| {
			data: null;
			error: {
				code:
					| "UNAUTHENTICATED"
					| "SESSION_NOT_FRESH"
					| "FORBIDDEN"
					| "NOT_FOUND"
					| "INVALID_INPUT"
					| "CONFLICT"
					| "RATE_LIMITED"
					| "UNAVAILABLE"
					| "CAPACITY"
					| "TIMEOUT"
					| "CANCELLED";
				message: string;
				reason?: FailureReason;
			};
	  };

export class MutationFailure extends Error {
	constructor(readonly failure: NonNullable<OperationResult<never>["error"]>) {
		super(failure.code);
	}
}

export function unwrapOperation<T>(result: OperationResult<T>): T {
	if (result.error) throw new MutationFailure(result.error);
	return result.data;
}
