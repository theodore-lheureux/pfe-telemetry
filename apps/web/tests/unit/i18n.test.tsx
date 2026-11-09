import { describe, expect, test } from "bun:test";
import {
	formatDate,
	formatNumber,
	formatSeconds,
	requestLocale,
} from "@recount/i18n";
import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { paraglideMiddleware } from "@recount/i18n/server";
import {
	renderOrganizationInvitationEmail,
	renderSignInCodeEmail,
} from "@recount/transactional";
import { operationMessage } from "../../src/lib/operation-message";

describe("request-isolated English and French", () => {
	test("validates preference consistently and defaults to English", () => {
		expect(requestLocale(new Headers({ "accept-language": "fr" }))).toBe("en");
		for (const [cookie, locale] of [
			["", "en"],
			["recount_locale=fr", "fr"],
			["recount_locale=FR", "fr"],
			["recount_locale=de", "en"],
			["recount_locale=%66r", "en"],
		] as const) {
			expect(requestLocale(new Headers({ cookie }))).toBe(locale);
		}
	});

	test("stable errors and unknown codes never expose raw server text in French", async () => {
		const unknown = {
			code: "constructor",
			message: "Private English SMTP diagnostic",
		};
		const response = await paraglideMiddleware(
			new Request("https://telemetry.example.invalid", {
				headers: { cookie: "recount_locale=fr" },
			}),
			() =>
				Response.json([
					operationMessage({ code: "RATE_LIMITED" }),
					operationMessage({ code: "INVALID_INPUT", reason: "INVALID_EXPIRY" }),
					operationMessage(unknown),
				]),
		);
		expect(await response.json()).toEqual([
			"Trop de tentatives. Patientez une minute avant de réessayer.",
			"Choisissez une expiration future ou laissez ce champ vide.",
			"L’action n’a pas pu aboutir. Actualisez la page avant de réessayer.",
		]);
	});

	test("interleaved request work, formatting and errors cannot bleed locales", async () => {
		const responses = await Promise.all(
			Array.from({ length: 20 }, (_, index) => {
				const locale = index % 2 ? "fr" : "en";
				return paraglideMiddleware(
					new Request("https://telemetry.example.invalid/login", {
						headers: { cookie: `recount_locale=${locale}` },
					}),
					async () => {
						await new Promise((resolve) => setTimeout(resolve, index % 3));
						return Response.json({
							locale: getLocale(),
							name: m.name(),
							error: operationMessage({
								code: "CONFLICT",
								reason: "LAST_OWNER",
							}),
							date: formatDate("2026-01-01T00:00:00Z"),
						});
					},
				);
			}),
		);
		for (const [index, response] of responses.entries()) {
			const body = await response.json();
			expect(body.locale).toBe(index % 2 ? "fr" : "en");
			expect(body.name).toBe(index % 2 ? "Nom" : "Name");
			expect(body.error).toContain(
				index % 2 ? "conserver un propriétaire" : "retain an owner",
			);
			expect(body.date).toContain(index % 2 ? "janv." : "Jan");
		}
		expect(getLocale()).toBe("en");
	});

	test("uses explicit locale, UTC and Intl unit plurals", () => {
		expect(formatNumber(1234.5, "fr")).toBe("1\u202f234,5");
		expect(formatNumber(1234.5, "en")).toBe("1,234.5");
		expect(formatSeconds(1, "fr")).toBe("1\u00a0seconde");
		expect(formatSeconds(2, "fr")).toBe("2\u00a0secondes");
		expect(formatDate("2026-01-01T01:00:00+01:00", "fr")).toContain("00:00:00");
	});
});

test("both email locales stay explicit across concurrent subjects, previews, text and HTML", async () => {
	const url = "https://telemetry.example.invalid/invitations/opaque-id";
	const rendered = await Promise.all(
		(["en", "fr"] as const).map(async (locale) => {
			const [signIn, invitation] = await Promise.all([
				renderSignInCodeEmail("012345", locale),
				renderOrganizationInvitationEmail({
					locale,
					url,
					email: "recipient@example.invalid",
					organizationName: "<script>private name</script>",
					inviterEmail: "sender@example.invalid",
					role: "admin",
					expiresAt: new Date("2026-11-05T12:00:00Z"),
				}),
			]);
			return { locale, signIn, invitation };
		}),
	);
	for (const { locale, signIn, invitation } of rendered) {
		for (const email of [signIn, invitation]) {
			expect(email.html).toContain(`lang="${locale}"`);
			expect(email.html).not.toContain("<script>");
			expect(email.html).toContain('name="color-scheme" content="light"');
			expect(email.html).not.toContain("prefers-color-scheme");
			expect(email.html).not.toContain("recount-email-card");
			expect(email.html.match(/<h1\b/g)).toHaveLength(1);
			expect(email.html.match(/<img\b/g)).toHaveLength(1);
			expect(email.html).toContain('alt="Recount"');
		}
		expect(signIn.html).toContain(
			locale === "fr"
				? "Utilisez votre code à usage unique pour vous connecter à Recount."
				: "Use your one-time code to sign in to Recount.",
		);
		expect(invitation.html).toContain(
			locale === "fr"
				? "Vous êtes invité à rejoindre &lt;script&gt;private name&lt;/script&gt; sur Recount"
				: "You are invited to join &lt;script&gt;private name&lt;/script&gt; on Recount",
		);
		expect(invitation.html).toContain(`href="${url}"`);
		expect(invitation.text).toContain(url);
		expect(signIn.text).toContain("012345");
		expect(signIn.subject).toBe(
			locale === "fr"
				? "Votre code de connexion Recount"
				: "Your Recount sign-in code",
		);
		expect(invitation.subject).toBe(
			locale === "fr"
				? "Vous êtes invité à une organisation sur Recount"
				: "You are invited to an organization on Recount",
		);
		expect(invitation.text).toContain(
			locale === "fr"
				? "Ouvrir le lien ne l’accepte pas"
				: "Opening the link does not accept it",
		);
		expect(invitation.html).toContain("&lt;script&gt;");
		for (const context of [
			"recipient@example.invalid",
			"sender@example.invalid",
			locale === "fr" ? "Administrateur" : "Administrator",
			locale === "fr" ? "5 nov. 2026 12:00:00 UTC" : "Nov 5, 2026 12:00:00 UTC",
			locale === "fr"
				? "Connectez-vous avec recipient@example.invalid et vérifiez votre adresse e-mail pour consulter cette invitation."
				: "Sign in with recipient@example.invalid and verify your email to review this invitation.",
			locale === "fr"
				? "Ne transmettez pas ce lien."
				: "Do not forward this link.",
		]) {
			expect(invitation.text).toContain(context);
		}
		expect(invitation.html.indexOf(url)).toBeLessThan(
			invitation.html.indexOf('alt="Recount"'),
		);
	}
});
