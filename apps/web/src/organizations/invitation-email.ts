import { email, safeParse } from "zod/mini";

const invitationEmail = email();

export function isInvitationEmail(value: string) {
	return safeParse(invitationEmail, value).success;
}
