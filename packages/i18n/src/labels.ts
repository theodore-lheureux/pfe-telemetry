import { m } from "./paraglide/messages.js";
import { getLocale, type Locale } from "./paraglide/runtime.js";

const roles = {
	owner: m.role_owner,
	admin: m.role_admin,
	member: m.role_member,
	viewer: m.role_viewer,
};
export function roleLabel(
	role: keyof typeof roles,
	locale: Locale = getLocale(),
) {
	return roles[role]({}, { locale });
}

const statuses = {
	pending: m.status_pending,
	accepted: m.status_accepted,
	rejected: m.status_rejected,
	canceled: m.status_canceled,
	expired: m.status_expired,
	Active: m.status_active,
	Expired: m.status_expired,
	Revoked: m.status_revoked,
};
export function statusLabel(status: string) {
	return Object.hasOwn(statuses, status)
		? statuses[status as keyof typeof statuses]()
		: m.status_unknown();
}
