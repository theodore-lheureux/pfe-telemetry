import { formatDate, type Locale } from "@pfe/i18n";
import { roleLabel } from "@pfe/i18n/labels";
import { m } from "@pfe/i18n/messages";
import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Text,
} from "react-email";

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
		<Html lang={locale}>
			<Head />
			<Preview>
				{m.email_invitation_preview(
					{ organization: organizationName },
					{ locale },
				)}
			</Preview>
			<Body
				style={{ backgroundColor: "#f5f5f5", fontFamily: "Arial, sans-serif" }}
			>
				<Container
					style={{
						backgroundColor: "#fff",
						padding: "32px",
						margin: "32px auto",
						maxWidth: "480px",
					}}
				>
					<Heading>
						{m.email_invitation_heading(
							{ organization: organizationName },
							{ locale },
						)}
					</Heading>
					<Text>
						{m.email_invitation_body(
							{
								inviter: inviterEmail,
								organization: organizationName,
								role: roleLabel(role, locale),
							},
							{ locale },
						)}
					</Text>
					<Text>{m.email_invitation_review({ email }, { locale })}</Text>
					<Button
						href={url}
						style={{
							backgroundColor: "#171717",
							color: "#fff",
							padding: "12px 20px",
							borderRadius: "6px",
						}}
					>
						{m.email_invitation_button({}, { locale })}
					</Button>
					<Text>
						{m.email_invitation_expiry(
							{ date: formatDate(expiresAt, locale) },
							{ locale },
						)}
					</Text>
					<Text>{m.email_link_fallback({}, { locale })}</Text>
					<Link href={url}>{url}</Link>
					<Text>{m.email_invitation_ignore({}, { locale })}</Text>
				</Container>
			</Body>
		</Html>
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
