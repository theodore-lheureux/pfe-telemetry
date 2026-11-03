import { renderSignInEmail } from "@pfe/transactional";
import nodemailer from "nodemailer";

let sender: ReturnType<typeof createLinkSender> | undefined;

export async function sendSignInLink(email: string, url: string) {
	sender ??= createLinkSender();
	await sender(email, url);
}

export function createLinkSender(env = process.env) {
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
	const transport = nodemailer.createTransport({
		host: SMTP_HOST,
		port: Number(SMTP_PORT),
		secure: SMTP_PORT === "465",
		requireTLS: true,
		auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 15_000,
	});

	return async (email: string, url: string) => {
		try {
			const message = await renderSignInEmail(url);
			await transport.sendMail({
				from: EMAIL_FROM,
				to: email,
				...message,
			});
		} catch {
			throw new Error("Sign-in email delivery failed");
		}
	};
}
