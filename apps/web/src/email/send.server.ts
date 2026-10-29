import type { Locale } from "@pfe/i18n";
import {
	type OrganizationInvitationEmailProps,
	renderOrganizationInvitationEmail,
	renderSignInEmail,
} from "@pfe/transactional";
import nodemailer, { type Transporter } from "nodemailer";

let sender: ReturnType<typeof createEmailSender> | undefined;

export async function sendSignInLink(
	email: string,
	url: string,
	locale: Locale,
) {
	sender ??= createEmailSender();
	await sender.sendSignInLink(email, url, locale);
}

export async function sendOrganizationInvitation(
	props: OrganizationInvitationEmailProps,
) {
	sender ??= createEmailSender();
	await sender.sendOrganizationInvitation(props);
}

export function createEmailSender(
	env = process.env,
	transport?: Pick<Transporter, "sendMail">,
) {
	const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM } = env;
	if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !EMAIL_FROM) {
		throw new Error(
			"SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM are required",
		);
	}
	if (
		!/^\d+$/.test(SMTP_PORT ?? "") ||
		Number(SMTP_PORT) < 1 ||
		Number(SMTP_PORT) > 65535
	) {
		throw new Error("SMTP_PORT must be an integer from 1 to 65535");
	}
	const mailer =
		transport ??
		nodemailer.createTransport({
			host: SMTP_HOST,
			port: Number(SMTP_PORT),
			secure: SMTP_PORT === "465",
			requireTLS: true,
			auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 15_000,
		});

	async function deliver(
		email: string,
		message: { subject: string; html: string; text: string },
	) {
		try {
			await mailer.sendMail({
				from: EMAIL_FROM,
				to: email,
				...message,
			});
		} catch {
			throw new Error("Email delivery failed");
		}
	}
	return {
		sendSignInLink: async (email: string, url: string, locale: Locale) =>
			deliver(email, await renderSignInEmail(url, locale)),
		sendOrganizationInvitation: async (
			props: OrganizationInvitationEmailProps,
		) => deliver(props.email, await renderOrganizationInvitationEmail(props)),
	};
}
