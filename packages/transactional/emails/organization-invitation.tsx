import { formatDate, type Locale } from "@recount/i18n";
import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import { Button, Heading, Link, Text } from "react-email";
import { EmailLayout, emailStyles } from "../src/email-layout";

export interface OrganizationInvitationEmailProps {
	locale: Locale;
	url: string;
	organizationName: string;
	inviterEmail: string;
	email: string;
	role: "owner" | "admin" | "member";
	expiresAt: Date;
}

export default function OrganizationInvitationEmail({
	url,
	organizationName,
	inviterEmail,
	email,
	role,
	expiresAt,
	locale,
}: OrganizationInvitationEmailProps) {
	return (
		<EmailLayout
			locale={locale}
			preview={m.email_invitation_preview(
				{ organization: organizationName },
				{ locale },
			)}
		>
			<Heading style={emailStyles.heading}>
				{m.email_invitation_heading(
					{ organization: organizationName },
					{ locale },
				)}
			</Heading>
			<Text style={emailStyles.text}>
				{m.email_invitation_body(
					{
						inviter: inviterEmail,
						organization: organizationName,
						role: roleLabel(role, locale),
					},
					{ locale },
				)}
			</Text>
			<Text style={emailStyles.text}>
				{m.email_invitation_review({ email }, { locale })}
			</Text>
			<Button
				href={url}
				className="recount-email-button"
				style={emailStyles.button}
			>
				{m.email_invitation_button({}, { locale })}
			</Button>
			<Text style={emailStyles.text}>
				{m.email_invitation_expiry(
					{ date: formatDate(expiresAt, locale) },
					{ locale },
				)}
			</Text>
			<Text style={emailStyles.text}>
				{m.email_link_fallback({}, { locale })}
			</Text>
			<Link className="recount-email-link" href={url} style={emailStyles.link}>
				{url}
			</Link>
			<Text style={emailStyles.text}>
				{m.email_invitation_ignore({}, { locale })}
			</Text>
		</EmailLayout>
	);
}

OrganizationInvitationEmail.PreviewProps = {
	locale: "en",
	url: "https://telemetry.example.com/invitations/example-invitation",
	organizationName: "Example organization",
	inviterEmail: "owner@example.com",
	email: "member@example.com",
	role: "member",
	expiresAt: new Date("2026-11-05T12:00:00Z"),
} satisfies OrganizationInvitationEmailProps;
