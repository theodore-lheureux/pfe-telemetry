import { m } from "@recount/i18n/messages";
import type { FailureReason } from "../organizations/contracts";
import { InputError } from "./input-error";

const reasons = {
	REQUEST_ID_REUSED: m.error_request_id_reused,
	LAST_OWNER: m.error_last_owner,
	VERIFIED_EMAIL_REQUIRED: m.error_verified_email,
	INVALID_TIME_RANGE: m.error_invalid_range,
	INVALID_EXECUTION_WINDOW: m.error_execution_window,
	INVALID_EXPIRY: m.error_expiry,
	INVALID_NAME: m.error_name,
	HOSTS_REQUIRED: m.error_hosts_required,
	HOSTS_UNIQUE: m.error_hosts_unique,
	INVALID_IDENTIFIER: m.error_identifier,
	CREDENTIAL_INACTIVE: m.error_credential_inactive,
} satisfies Record<FailureReason, () => string>;

const codes: Record<string, () => string> = {
	UNAUTHENTICATED: m.error_unauthenticated,
	FORBIDDEN: m.error_forbidden,
	NOT_FOUND: m.error_not_found,
	INVALID_INPUT: m.error_invalid_input,
	CONFLICT: m.error_conflict,
	RATE_LIMITED: m.error_rate_limited,
	SESSION_NOT_FRESH: m.error_session_fresh,
	UNAVAILABLE: m.error_telemetry_unavailable,
	CAPACITY: m.error_telemetry_capacity,
	TIMEOUT: m.error_telemetry_timeout,
	QUERY_FAILED: m.error_telemetry_query,
	CANCELLED: m.error_telemetry_cancelled,
};

export function operationMessage(error: {
	code?: string;
	reason?: FailureReason;
}) {
	if (error.reason && Object.hasOwn(reasons, error.reason))
		return reasons[error.reason]();
	if (error.code && Object.hasOwn(codes, error.code))
		return codes[error.code]();
	return m.error_unknown();
}

export function inputMessage(error: unknown) {
	return error instanceof InputError
		? reasons[error.reason]()
		: m.error_invalid_input();
}
