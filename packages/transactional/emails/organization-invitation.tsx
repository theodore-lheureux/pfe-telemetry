import { formatDate, type Locale } from "@recount/i18n";
import { roleLabel } from "@recount/i18n/labels";
import { m } from "@recount/i18n/messages";
import {
	EmailButton,
	EmailLinkFallback,
	EmailNote,
	EmailText,
} from "../src/email-components";
import { EmailLayout } from "../src/email-layout";

export interface OrganizationInvitationEmailProps {
	locale: Locale;
	url: string;
	organizationName: string;
	inviterEmail: string;
	/** Shown in place of the inviter's email when they have set a name. */
	inviterName?: string;
	email: string;
	role: "owner" | "admin" | "member";
	expiresAt: Date;
	recipientName?: string;
	message?: string;
	/** Image source for the inviter's photo, usually an inline attachment's `cid:` URL. */
	inviterAvatar?: string;
}

export default function OrganizationInvitationEmail({
	url,
	organizationName,
	inviterEmail,
	inviterName,
	email,
	role,
	expiresAt,
	locale,
	recipientName,
	message,
	inviterAvatar,
}: OrganizationInvitationEmailProps) {
	const inviter = inviterName?.trim() || inviterEmail;
	return (
		<EmailLayout
			locale={locale}
			preview={m.email_invitation_preview(
				{ organization: organizationName },
				{ locale },
			)}
			title={m.email_invitation_heading(
				{ organization: organizationName },
				{ locale },
			)}
			footer={
				<EmailText tone="footer">
					{m.email_invitation_ignore({}, { locale })}
				</EmailText>
			}
		>
			{recipientName && (
				<EmailText>
					{m.email_invitation_greeting({ name: recipientName }, { locale })}
				</EmailText>
			)}
			<EmailText>
				{m.email_invitation_body(
					{
						inviter,
						organization: organizationName,
						role: roleLabel(role, locale),
					},
					{ locale },
				)}
			</EmailText>
			{message && (
				<EmailNote author={inviter} avatarSrc={inviterAvatar}>
					{message}
				</EmailNote>
			)}
			<EmailButton href={url}>
				{m.email_invitation_button({}, { locale })}
			</EmailButton>
			<EmailText tone="small">
				{m.email_invitation_review({ email }, { locale })}
			</EmailText>
			<EmailText tone="small">
				{m.email_invitation_expiry(
					{ date: formatDate(expiresAt, locale) },
					{ locale },
				)}
			</EmailText>
			<EmailLinkFallback
				label={m.email_link_fallback({}, { locale })}
				href={url}
			/>
		</EmailLayout>
	);
}

OrganizationInvitationEmail.PreviewProps = {
	locale: "en",
	url: "https://telemetry.example.com/invitations/example-invitation",
	organizationName: "Example organization",
	inviterEmail: "owner@example.com",
	inviterName: "Sam Rivera",
	email: "member@example.com",
	role: "member",
	expiresAt: new Date("2026-11-05T12:00:00Z"),
	recipientName: "Alex",
	message: "Welcome aboard. The staging project is ready for you.",
} satisfies OrganizationInvitationEmailProps;
