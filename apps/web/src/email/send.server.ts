import type { Locale } from "@recount/i18n";
import {
	emailBrandImages,
	type OrganizationInvitationEmailProps,
	renderOrganizationInvitationEmail,
	renderSignInCodeEmail,
} from "@recount/transactional";
import nodemailer, { type Transporter } from "nodemailer";

let sender: ReturnType<typeof createEmailSender> | undefined;

export async function sendOrganizationInvitation(
	props: OrganizationInvitationEmailProps,
) {
	sender ??= createEmailSender();
	await sender.sendOrganizationInvitation(props);
}

export async function sendSignInCode(
	email: string,
	code: string,
	locale: Locale,
) {
	sender ??= createEmailSender();
	await sender.sendSignInCode(email, code, locale);
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
				attachments: emailBrandImages.map((image) => ({
					filename: image.filename,
					cid: image.cid,
					content: Buffer.from(image.base64, "base64"),
					contentType: "image/png",
					contentDisposition: "inline" as const,
				})),
			});
		} catch {
			throw new Error("Email delivery failed");
		}
	}
	return {
		sendSignInCode: async (email: string, code: string, locale: Locale) =>
			deliver(email, await renderSignInCodeEmail(code, locale)),
		sendOrganizationInvitation: async (
			props: OrganizationInvitationEmailProps,
		) => deliver(props.email, await renderOrganizationInvitationEmail(props)),
	};
}
