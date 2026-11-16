import { m } from "@recount/i18n/messages";

export function profileEmailError(code: string | undefined, status: number) {
	if (status === 429) return m.code_rate_limited();
	if (code === "ACCOUNT_CHANGED" || code === "INVALID_USER")
		return m.reauth_account_changed();
	if (code === "SESSION_NOT_FRESH") return m.error_session_fresh();
	if (code === "EMAIL_UNCHANGED") return m.profile_email_change_unchanged();
	if (code === "TOKEN_EXPIRED") return m.profile_email_change_expired();
	if (code === "INVALID_TOKEN" || code === "USER_NOT_FOUND")
		return m.profile_email_change_invalid();
	return m.profile_email_change_failed();
}
