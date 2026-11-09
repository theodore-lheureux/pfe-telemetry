import { describe, expect, test } from "bun:test";
import { localRedirect, loginSearch } from "../../src/auth/redirect";

describe("sign-in return destinations", () => {
	const origin = "https://telemetry.example.invalid";
	test("preserves local invitation and tenant return destinations", () => {
		const invitation = "/invitations/opaque-invitation?from=email";
		expect(loginSearch({ redirect: invitation }, origin).redirect).toBe(
			invitation,
		);
		expect(
			localRedirect(
				"/organizations/org/projects/project/executions#chart",
				origin,
			),
		).toBe("/organizations/org/projects/project/executions#chart");
	});
	test("rejects external, scheme-relative and browser-normalized unsafe destinations", () => {
		for (const value of [
			undefined,
			42,
			"",
			"https://evil.invalid/",
			"//evil.invalid/",
			"/\\evil.invalid",
			"/%5cevil.invalid",
			"/\nevil.invalid",
			"/.//evil.invalid",
			"javascript:alert(1)",
			"relative/path",
		])
			expect(loginSearch({ redirect: value }, origin).redirect).toBe("/");
	});
	test("uses the supplied application origin without changing local destinations", () => {
		const destination = "/invitations/test?from=email#review";
		for (const applicationOrigin of [
			"http://localhost:3001",
			"https://another.example.invalid",
		]) {
			expect(
				loginSearch({ redirect: destination }, applicationOrigin).redirect,
			).toBe(destination);
			expect(
				loginSearch({ redirect: "/.//untrusted.invalid" }, applicationOrigin)
					.redirect,
			).toBe("/");
		}
	});
	test("defaults safely without carrying callback-only branches", () => {
		expect(loginSearch({}, origin)).toEqual({ redirect: "/" });
	});
});
