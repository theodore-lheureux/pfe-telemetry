import { APIError } from "better-auth/api";
import type { OperationResult } from "./contracts";
import { OperationError, type OperationErrorCode } from "./errors";

function postgresCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return;
	if ("code" in error && typeof error.code === "string") return error.code;
	return "cause" in error ? postgresCode(error.cause) : undefined;
}

function ownerConstraint(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (
		"code" in error &&
		error.code === "23514" &&
		"constraint" in error &&
		error.constraint === "organization_must_retain_owner"
	)
		return true;
	return "cause" in error && ownerConstraint(error.cause);
}

export async function operationResult<T>(
	operation: () => Promise<T>,
): Promise<OperationResult<T>> {
	try {
		return { data: await operation(), error: null };
	} catch (error) {
		if (error instanceof OperationError)
			return {
				data: null,
				error: {
					code: error.code,
					message: error.message,
					reason: error.reason,
				},
			};
		if (postgresCode(error) === "23505")
			return {
				data: null,
				error: {
					code: "CONFLICT",
					message: "This slug or membership is already in use",
				},
			};
		if (
			ownerConstraint(error) ||
			(error instanceof APIError &&
				[
					"YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
					"YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
				].includes(error.body?.code ?? ""))
		)
			return {
				data: null,
				error: {
					code: "CONFLICT",
					message:
						"The organization must retain an owner. Ask an existing owner to promote another member to owner, then retry. Administrators cannot appoint owners.",
					reason: "LAST_OWNER",
				},
			};
		if (error instanceof APIError) {
			if (error.statusCode >= 500) throw error;
			const statusCodes: Partial<Record<number, OperationErrorCode>> = {
				401: "UNAUTHENTICATED",
				403: "FORBIDDEN",
				404: "NOT_FOUND",
				409: "CONFLICT",
				429: "RATE_LIMITED",
			};
			const duplicate = [
				"ORGANIZATION_SLUG_ALREADY_TAKEN",
				"ORGANIZATION_ALREADY_EXISTS",
				"USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
				"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
			].includes(error.body?.code ?? "");
			const unavailable = [
				"INVITATION_NOT_FOUND",
				"ORGANIZATION_NOT_FOUND",
				"MEMBER_NOT_FOUND",
			].includes(error.body?.code ?? "");
			return {
				data: null,
				error: {
					code:
						error.body?.code === "SESSION_NOT_FRESH"
							? "SESSION_NOT_FRESH"
							: duplicate
								? "CONFLICT"
								: unavailable
									? "NOT_FOUND"
									: (statusCodes[error.statusCode] ?? "INVALID_INPUT"),
					message: error.body?.message ?? "Organization operation failed",
				},
			};
		}
		throw error;
	}
}
