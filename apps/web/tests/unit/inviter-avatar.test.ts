import { expect, test } from "bun:test";
import nodemailer from "nodemailer";
import { fetchGravatar } from "../../src/email/inviter-avatar.server";
import { createEmailSender } from "../../src/email/send.server";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const respond = (response: () => Response) => async () => response();

test("Gravatar photos are fetched once and anything else falls back to the initial", async () => {
	const requested: string[] = [];
	const avatar = await fetchGravatar("Owner@Example.com ", async (url) => {
		requested.push(url);
		return new Response(png, { headers: { "Content-Type": "image/png" } });
	});
	expect(avatar?.contentType).toBe("image/png");
	expect(avatar?.content.equals(Buffer.from(png))).toBe(true);
	expect(requested).toHaveLength(1);
	expect(requested[0]).toMatch(
		/^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?d=404/,
	);

	const offline = async (): Promise<Response> => {
		throw new Error("offline");
	};
	for (const fetcher of [
		respond(() => new Response(null, { status: 404 })),
		respond(
			() =>
				new Response("<svg/>", {
					headers: { "Content-Type": "image/svg+xml" },
				}),
		),
		respond(
			() =>
				new Response(new Uint8Array(70 * 1024), {
					headers: { "Content-Type": "image/png" },
				}),
		),
		offline,
	]) {
		expect(await fetchGravatar("owner@example.com", fetcher)).toBeNull();
	}
});

test("invitations attach the inviter photo only beside a personal message", async () => {
	const sent: { html: string; attachments: { cid: string }[] }[] = [];
	const transport = nodemailer.createTransport({ jsonTransport: true });
	const lookups: string[] = [];
	const sender = createEmailSender(
		{
			SMTP_HOST: "smtp.example.invalid",
			SMTP_PORT: "587",
			SMTP_USER: "test-only",
			SMTP_PASSWORD: "test-only",
			EMAIL_FROM: "Recount <sender@example.invalid>",
		},
		{
			sendMail: async (message) => {
				const result = await transport.sendMail(message);
				sent.push(JSON.parse(result.message.toString()));
				return result;
			},
		},
		async (email) => {
			lookups.push(email);
			return { content: Buffer.from(png), contentType: "image/png" };
		},
	);
	const props = {
		locale: "en" as const,
		url: "https://telemetry.example.com/invitations/test-id",
		email: "recipient@example.invalid",
		organizationName: "Example",
		inviterEmail: "owner@example.invalid",
		role: "member" as const,
		expiresAt: new Date("2026-11-05T12:00:00Z"),
	};
	await sender.sendOrganizationInvitation(props);
	await sender.sendOrganizationInvitation({ ...props, message: "Welcome" });
	expect(lookups).toEqual(["owner@example.invalid"]);
	expect(sent[0].attachments.map((a) => a.cid)).not.toContain("inviter-avatar");
	expect(sent[0].html).not.toContain("cid:inviter-avatar");
	expect(sent[1].attachments.map((a) => a.cid)).toContain("inviter-avatar");
	expect(sent[1].html).toContain('src="cid:inviter-avatar"');
});
