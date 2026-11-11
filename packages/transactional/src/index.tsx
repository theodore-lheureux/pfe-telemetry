import { m } from "@recount/i18n/messages";
import { render, toPlainText } from "react-email";
import OrganizationInvitationEmail, {
	type OrganizationInvitationEmailProps,
} from "../emails/organization-invitation";
import SignInCodeEmail, {
	type SignInCodeEmailProps,
} from "../emails/sign-in-code";
import { emailBrandAssets } from "./brand-assets";

export const emailBrandImages = [
	{
		filename: "recount-lockup-on-light.png",
		cid: "recount-logo-light",
		base64: emailBrandAssets.light,
	},
	{
		filename: "recount-symbol-teal.png",
		cid: "recount-symbol",
		base64: emailBrandAssets.symbol,
	},
];

export type { OrganizationInvitationEmailProps } from "../emails/organization-invitation";
export type { SignInCodeEmailProps } from "../emails/sign-in-code";

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

export async function renderSignInCodeEmail(
	props: SignInCodeEmailProps,
): Promise<{ subject: string; html: string; text: string }> {
	const html = await render(<SignInCodeEmail {...props} />);
	return {
		subject: m.email_code_subject({}, { locale: props.locale }),
		html,
		text: toPlainText(html),
	};
}
