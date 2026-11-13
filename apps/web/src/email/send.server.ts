import type { Locale } from "@recount/i18n";
import {
	emailBrandImages,
	type OrganizationInvitationEmailProps,
	renderOrganizationInvitationEmail,
	renderSignInCodeEmail,
} from "@recount/transactional";
import nodemailer, { type Transporter } from "nodemailer";
import * as z from "zod";
import { type Env, integer, readEnv } from "../lib/env.server";
import { fetchGravatar, type InlineAvatar } from "./inviter-avatar.server";

const INVITER_AVATAR_CID = "inviter-avatar";

const required = z
	.string({
		error: "SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM are required",
	})
	.min(1, "SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM are required");

const settings = z.object({
	SMTP_HOST: required,
	SMTP_PORT: integer("SMTP_PORT", 1, 65535),
	SMTP_USER: required,
	SMTP_PASSWORD: required,
	EMAIL_FROM: required,
});

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
	url: string,
) {
	sender ??= createEmailSender();
	await sender.sendSignInCode(email, code, locale, url);
}

export function createEmailSender(
	env: Env = process.env,
	transport?: Pick<Transporter, "sendMail">,
	loadAvatar: (email: string) => Promise<InlineAvatar | null> = fetchGravatar,
) {
	const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM } =
		readEnv(settings, env);
	const mailer =
		transport ??
		nodemailer.createTransport({
			host: SMTP_HOST,
			port: SMTP_PORT,
			secure: SMTP_PORT === 465,
			requireTLS: true,
			auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 15_000,
		});

	async function deliver(
		email: string,
		message: { subject: string; html: string; text: string },
		avatar: InlineAvatar | null = null,
	) {
		try {
			await mailer.sendMail({
				from: EMAIL_FROM,
				to: email,
				...message,
				attachments: [
					...emailBrandImages.map((image) => ({
						filename: image.filename,
						cid: image.cid,
						content: Buffer.from(image.base64, "base64"),
						contentType: "image/png",
					})),
					...(avatar
						? [
								{
									filename: `inviter-avatar.${avatar.contentType.slice("image/".length)}`,
									cid: INVITER_AVATAR_CID,
									content: avatar.content,
									contentType: avatar.contentType,
								},
							]
						: []),
				].map((attachment) => ({
					...attachment,
					contentDisposition: "inline" as const,
				})),
			});
		} catch {
			throw new Error("Email delivery failed");
		}
	}
	return {
		sendSignInCode: async (
			email: string,
			code: string,
			locale: Locale,
			url: string,
		) => deliver(email, await renderSignInCodeEmail({ code, locale, url })),
		sendOrganizationInvitation: async (
			props: OrganizationInvitationEmailProps,
		) => {
			// The photo only appears beside a personal message.
			const avatar = props.message
				? await loadAvatar(props.inviterEmail)
				: null;
			const message = await renderOrganizationInvitationEmail({
				...props,
				inviterAvatar: avatar ? `cid:${INVITER_AVATAR_CID}` : undefined,
			});
			await deliver(props.email, message, avatar);
		},
	};
}
