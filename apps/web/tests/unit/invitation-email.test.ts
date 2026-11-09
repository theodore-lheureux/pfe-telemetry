import { describe, expect, test } from "bun:test";
import {
	type OrganizationInvitationEmailProps,
	renderOrganizationInvitationEmail,
	renderSignInCodeEmail,
} from "@recount/transactional";
import nodemailer from "nodemailer";
import { createEmailSender } from "../../src/email/send.server";
import {
	parseCreateInvitationInput,
	parseInvitationReference,
} from "../../src/organizations/invitation-validation";

const props: OrganizationInvitationEmailProps = {
	locale: "en",
	url: "https://telemetry.example.com/invitations/test-id",
	email: "recipient@example.invalid",
	organizationName: '<script>alert("untrusted")</script>',
	inviterEmail: "owner@example.invalid",
	role: "admin",
	expiresAt: new Date("2026-11-05T12:00:00Z"),
};
const env = {
	SMTP_HOST: "smtp.example.invalid",
	SMTP_PORT: "587",
	SMTP_USER: "test-only",
	SMTP_PASSWORD: "test-only",
	EMAIL_FROM: "Recount <sender@example.invalid>",
};

describe("invitation email", () => {
	test("renders escaped, accessible HTML and plain text with review context", async () => {
		const message = await renderOrganizationInvitationEmail(props);
		expect(message.subject).toBe(
			"You are invited to an organization on Recount",
		);
		expect(message.html).toContain('lang="en"');
		expect(message.html).toContain("&lt;script&gt;");
		expect(message.html).not.toContain("<script>");
		expect(message.html).toContain(`href="${props.url}"`);
		for (const text of [
			"Review invitation",
			props.email,
			props.inviterEmail,
			"organization Administrator",
			"Nov 5, 2026",
			"Opening the link does not accept it",
			props.url,
		]) {
			expect(message.text).toContain(text);
		}
	});

	test("delivers branded templates through the same configured transport without SMTP", async () => {
		const messages: Record<string, unknown>[] = [];
		const transport = nodemailer.createTransport({ jsonTransport: true });
		const sender = createEmailSender(env, {
			sendMail: async (message) => {
				const sent = await transport.sendMail(message);
				messages.push(JSON.parse(sent.message.toString()));
				return sent;
			},
		});
		await sender.sendOrganizationInvitation(props);
		await sender.sendSignInCode(props.email, "012345", "fr");
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			to: [{ address: props.email, name: "" }],
			from: { address: "sender@example.invalid", name: "Recount" },
			subject: "You are invited to an organization on Recount",
		});
		expect(messages[0].html).toContain(props.url);
		expect(messages[0].text).toContain(props.url);
		expect(messages[1].subject).toBe("Votre code de connexion Recount");
		for (const message of messages) {
			const images = message.attachments as {
				cid: string;
				contentType: string;
				contentDisposition: string;
			}[];
			expect(images.map((image) => image.cid)).toEqual([
				"recount-logo-light",
				"recount-logo-dark",
			]);
			expect(
				images.every(
					(image) =>
						image.contentType === "image/png" &&
						image.contentDisposition === "inline",
				),
			).toBe(true);
			expect(message.html).toContain("cid:recount-logo-light");
			expect(message.html).toContain("cid:recount-logo-dark");
		}
		expect(messages[1].text).toContain("012345");
	});

	test("sanitizes transport failures and rejects incomplete SMTP configuration", async () => {
		const sender = createEmailSender(env, {
			sendMail: async () => {
				throw new Error("private SMTP diagnostics");
			},
		});
		await expect(sender.sendOrganizationInvitation(props)).rejects.toThrow(
			"Email delivery failed",
		);
		expect(() =>
			createEmailSender({ ...env, SMTP_PASSWORD: undefined }),
		).toThrow("are required");
		expect(() => createEmailSender({ ...env, SMTP_PORT: "0" })).toThrow(
			"SMTP_PORT",
		);
	});
});

test("code emails preserve leading zeros and explicit locale with accessible branding", async () => {
	const results = await Promise.all(
		(["en", "fr"] as const).map(async (locale) => ({
			locale,
			message: await renderSignInCodeEmail("012345", locale),
		})),
	);
	for (const { locale, message } of results) {
		expect(message.html).toContain(`lang="${locale}"`);
		expect(message.text).toContain("012345");
		expect(message.html.match(/aria-label="Recount"/g)).toHaveLength(1);
		expect(message.html).toContain("Helvetica Neue");
		expect(message.html).not.toContain("localhost");
		expect(message.text).toContain(
			locale === "fr" ? "Ne communiquez ce code" : "Do not share this code",
		);
	}
});

test("validates invitation identifiers, roles and resend input", () => {
	expect(
		parseCreateInvitationInput({
			organizationId: "org",
			email: " A@EXAMPLE.INVALID ",
			role: "member",
			resend: true,
		}),
	).toEqual({
		organizationId: "org",
		email: "a@example.invalid",
		role: "member",
		resend: true,
	});
	for (const role of ["admin,owner", ["member"], "viewer", undefined]) {
		expect(() =>
			parseCreateInvitationInput({
				organizationId: "org",
				email: "a@example.invalid",
				role,
			}),
		).toThrow();
	}
	expect(() =>
		parseCreateInvitationInput({
			organizationId: "org",
			email: "a@example.invalid\r\nbcc:x@example.invalid",
			role: "member",
		}),
	).toThrow();
	expect(() =>
		parseCreateInvitationInput({
			organizationId: "org",
			email: "a@example.invalid",
			role: "member",
			resend: "true",
		}),
	).toThrow();
	expect(() => parseInvitationReference({ invitationId: "" })).toThrow();
});
