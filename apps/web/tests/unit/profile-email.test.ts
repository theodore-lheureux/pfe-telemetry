import { expect, test } from "bun:test";
import { renderProfileEmail } from "@recount/transactional";
import type { SendMailOptions } from "nodemailer";
import { createEmailSender } from "../../src/email/send.server";

test("profile verification and previous-address notices have explicit EN/FR HTML and text without bearer recovery links", async () => {
	for (const locale of ["en", "fr"] as const) {
		const verification = await renderProfileEmail({
			kind: "verification",
			locale,
			email: "new@example.invalid",
			url: "https://recount.example.invalid/email-change?token=verification",
		});
		const notice = await renderProfileEmail({
			kind: "changed",
			locale,
			email: "old@example.invalid",
			newEmail: "<script>@example.invalid",
			url: "https://recount.example.invalid/settings?section=user",
		});
		expect(verification.html).toContain(`lang="${locale}"`);
		expect(notice.html).toContain(`lang="${locale}"`);
		expect(verification.text).toContain("/email-change?token=verification");
		expect(verification.text).toContain("new@example.invalid");
		expect(notice.text).toContain("old@example.invalid");
		expect(notice.html).toContain("&lt;script&gt;");
		expect(notice.html).not.toContain("<script>");
		expect(notice.text).toContain(
			"https://recount.example.invalid/settings?section=user",
		);
		expect(notice.text).not.toContain("012345");
		expect(notice.html).not.toContain("token=");
		expect(notice.text).not.toContain("ignore this email");
		expect(notice.text).not.toContain("ignorez cet e-mail");
		expect(verification.html).not.toContain("/login#");
		expect(verification.subject).not.toBe(notice.subject);
	}
});

test("profile email delivery uses the shared configured sender and sanitizes transport errors", async () => {
	const env = {
		SMTP_HOST: "smtp.example.invalid",
		SMTP_PORT: "587",
		SMTP_USER: "test-only",
		SMTP_PASSWORD: "test-only",
		EMAIL_FROM: "sender@example.invalid",
	};
	const messages: SendMailOptions[] = [];
	const sender = createEmailSender(env, {
		sendMail: async (message) => {
			messages.push(message);
			return { messageId: "fixture", envelope: { from: "", to: [] } };
		},
	});
	const props = {
		kind: "verification" as const,
		locale: "fr" as const,
		email: "new@example.invalid",
		url: "https://recount.example.invalid/email-change?token=verification",
	};
	await sender.sendProfileEmail(props);
	expect(messages[0]).toMatchObject({
		to: props.email,
		from: env.EMAIL_FROM,
		subject: "Vérifiez votre nouvelle adresse de connexion Recount",
	});
	const failing = createEmailSender(env, {
		sendMail: async () => {
			throw new Error("private SMTP details");
		},
	});
	await expect(failing.sendProfileEmail(props)).rejects.toThrow(
		"Email delivery failed",
	);
});
