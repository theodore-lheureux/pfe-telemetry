import type { Locale } from "@pfe/i18n";
import { m } from "@pfe/i18n/messages";
import { render, toPlainText } from "react-email";
import OrganizationInvitationEmail, {
	type OrganizationInvitationEmailProps,
} from "../emails/organization-invitation";
import SignInEmail from "../emails/sign-in";

export type { OrganizationInvitationEmailProps } from "../emails/organization-invitation";

export async function renderOrganizationInvitationEmail(
	props: OrganizationInvitationEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
	const html = await render(<OrganizationInvitationEmail {...props} />);
	return {
		subject: m.email_invitation_subject({}, { locale: props.locale }),
		html,
		text: toPlainText(html),
	};
}

export async function renderSignInEmail(
	url: string,
	locale: Locale,
): Promise<{ subject: string; html: string; text: string }> {
	const html = await render(<SignInEmail url={url} locale={locale} />);
	return {
		subject: m.email_sign_in_subject({}, { locale }),
		html,
		text: toPlainText(html),
	};
}
