import { describe, expect, test } from "bun:test";
import {
	emailBrandImages,
	type OrganizationInvitationEmailProps,
	renderOrganizationInvitationEmail,
	renderSignInCodeEmail,
} from "@recount/transactional";
import nodemailer from "nodemailer";
import { createEmailSender } from "../../src/email/send.server";
import {
	parseCreateInvitationInput,
	parseCreateInvitationsInput,
	parseInvitationReference,
} from "../../src/organizations/invitation-validation";

const signInUrl =
	"https://telemetry.example.com/login#email=member%40example.com&code=012345";

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
			`Sign in with ${props.email} and verify your email to review this invitation.`,
			"Do not forward this link",
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
		await sender.sendSignInCode(props.email, "012345", "fr", signInUrl);
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
				"recount-symbol",
			]);
			expect(
				images.every(
					(image) =>
						image.contentType === "image/png" &&
						image.contentDisposition === "inline",
				),
			).toBe(true);
			expect(String(message.html).match(/src="cid:[^"]+"/g)).toEqual([
				'src="cid:recount-logo-light"',
				'src="cid:recount-symbol"',
			]);
			expect(message.html).not.toContain("cid:recount-logo-dark");
			expect(message.html).not.toContain("data:image");
		}
		expect(messages[1].text).toContain("012345");
	});

	test("builds real multipart MIME with referenced inline PNGs without a network transport", async () => {
		const transport = nodemailer.createTransport({
			streamTransport: true,
			buffer: true,
			newline: "unix",
		});
		const messages: string[] = [];
		const sender = createEmailSender(env, {
			sendMail: async (message) => {
				const sent = await transport.sendMail(message);
				messages.push(sent.message.toString());
				return sent;
			},
		});
		await sender.sendOrganizationInvitation({ ...props, locale: "fr" });
		await sender.sendSignInCode(props.email, "012345", "en", signInUrl);
		for (const mime of messages) {
			expect(mime).toContain("Content-Type: multipart/alternative;");
			expect(mime).toContain("Content-Type: multipart/related;");
			expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
			expect(mime).toContain("Content-Type: text/html; charset=utf-8");
			expect(mime.match(/^Content-ID: .+$/gm)).toEqual([
				"Content-ID: <recount-logo-light>",
				"Content-ID: <recount-symbol>",
			]);
			expect(mime.match(/^Content-Type: image\/.+$/gm)).toEqual([
				"Content-Type: image/png; name=recount-lockup-on-light.png",
				"Content-Type: image/png; name=recount-symbol-teal.png",
			]);
			expect(mime).toContain(
				"Content-Disposition: inline; filename=recount-lockup-on-light.png",
			);
			expect(mime.replace(/=\n/g, "")).toContain("cid:recount-logo-light");
			expect(mime.replace(/=\n/g, "")).toContain("cid:recount-symbol");
			expect(mime).not.toContain("recount-logo-dark");
			const imagePart = mime.split("Content-Type: image/png;")[1];
			const encoded = imagePart.split("\n\n")[1].split("\n--")[0];
			expect(encoded.replace(/\s/g, "")).toBe(emailBrandImages[0].base64);
		}
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
			message: await renderSignInCodeEmail({
				code: "012345",
				locale,
				url: signInUrl,
			}),
		})),
	);
	for (const { locale, message } of results) {
		expect(message.html).toContain(`lang="${locale}"`);
		expect(message.text).toContain("012345");
		expect(message.html.match(/alt="Recount"/g)).toHaveLength(1);
		expect(message.html).not.toContain("localhost");
		expect(message.text).toContain(
			locale === "fr" ? "Ne communiquez ce code" : "Do not share this code",
		);
		expect(message.text).toContain(
			locale === "fr"
				? "Il expire après cinq minutes et ne peut être utilisé qu’une fois."
				: "It expires in five minutes and can only be used once.",
		);
		expect(message.text).toContain(
			locale === "fr"
				? "Si vous n’avez pas demandé ce code"
				: "If you did not request this code",
		);
	}
});

test("escapes invitation identities and fallback URL in both locales", async () => {
	for (const locale of ["en", "fr"] as const) {
		const organizationName = '<img src=x onerror="alert(1)"> & Partners';
		const url = `${props.url}?review=1&source=email`;
		const message = await renderOrganizationInvitationEmail({
			...props,
			locale,
			organizationName,
			url,
		});
		expect(message.html).toContain(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Partners",
		);
		expect(message.html).not.toContain("<img src=x");
		expect(message.html.match(/<img\b/g)).toHaveLength(2);
		const site =
			locale === "fr" ? "https://recount.cloud/fr" : "https://recount.cloud";
		expect(message.html.match(/href="[^"]+"/g)).toEqual([
			`href="${props.url}?review=1&amp;source=email"`,
			`href="${props.url}?review=1&amp;source=email"`,
			`href="${site}/docs/"`,
			`href="${site}/privacy/"`,
			`href="${site}/terms/"`,
			'href="https://github.com/theodore-lheureux/pfe-telemetry"',
		]);
		expect(message.text).toContain(organizationName);
		expect(message.text).toContain(url);
		const personalized = await renderOrganizationInvitationEmail({
			...props,
			locale,
			recipientName: "<Jane & team>",
			message: "Welcome <script>alert(1)</script>\nLet’s collaborate.",
		});
		expect(personalized.html).toContain("&lt;Jane &amp; team&gt;");
		expect(personalized.html).toContain("Welcome &lt;script&gt;");
		expect(personalized.html).not.toContain("<script>");
		expect(personalized.text).toContain("Let’s collaborate.");
	}
});

test("validates bounded optional invitation names and messages", () => {
	const input = {
		organizationId: "org",
		email: "jane@example.invalid",
		role: "member",
		recipientName: " Jane ",
		message: " Welcome\naboard ",
	};
	expect(parseCreateInvitationInput(input)).toMatchObject({
		recipientName: "Jane",
		message: "Welcome\naboard",
	});
	for (const extra of [
		{ recipientName: "x".repeat(101) },
		{ recipientName: "Jane\nDoe" },
		{ message: "x".repeat(2001) },
		{ message: "bad\u0000message" },
		{ message: {} },
	])
		expect(() => parseCreateInvitationInput({ ...input, ...extra })).toThrow();
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

test("validates complete invitation batches before any recipient can be sent", () => {
	const input = {
		organizationId: "org",
		message: " Welcome ",
		recipients: [
			{
				clientId: "first",
				email: " A@EXAMPLE.INVALID ",
				role: "member",
				recipientName: " Jane ",
			},
			{ clientId: "second", email: "b@example.invalid", role: "admin" },
		],
	};
	expect(parseCreateInvitationsInput(input)).toMatchObject({
		organizationId: "org",
		message: "Welcome",
		recipients: [
			{
				clientId: "first",
				email: "a@example.invalid",
				role: "member",
				recipientName: "Jane",
			},
			{ clientId: "second", email: "b@example.invalid", role: "admin" },
		],
	});
	for (const recipients of [
		[],
		null,
		Array.from({ length: 11 }, (_, i) => ({
			clientId: `${i}`,
			email: `person-${i}@example.invalid`,
			role: "member",
		})),
		[
			input.recipients[0],
			{ ...input.recipients[1], email: "a@example.invalid" },
		],
		[input.recipients[0], { ...input.recipients[1], clientId: "first" }],
		[input.recipients[0], { ...input.recipients[1], email: "invalid" }],
		[input.recipients[0], { ...input.recipients[1], role: "admin,owner" }],
	])
		expect(() =>
			parseCreateInvitationsInput({ ...input, recipients }),
		).toThrow();
});

test("invitations name the inviter when a name is set and fall back to their email", async () => {
	const named = await renderOrganizationInvitationEmail({
		...props,
		inviterName: "Sam Rivera",
		message: "Welcome",
	});
	expect(named.text).toContain("Sam Rivera invited you");
	expect(named.text).not.toContain(props.inviterEmail);
	const unnamed = await renderOrganizationInvitationEmail({
		...props,
		inviterName: "  ",
	});
	expect(unnamed.text).toContain(`${props.inviterEmail} invited you`);
});
