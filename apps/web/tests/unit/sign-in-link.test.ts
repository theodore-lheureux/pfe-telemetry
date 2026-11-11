import { expect, test } from "bun:test";
import { readSignInLink, signInLinkUrl } from "../../src/auth/sign-in-link";

test("sign-in links keep the code in the fragment and round-trip addresses", () => {
	const url = new URL(
		signInLinkUrl("https://telemetry.example.com", "a+b@example.com", "012345"),
	);
	expect(url.pathname).toBe("/login");
	expect(url.search).toBe("");
	expect(readSignInLink(url.hash)).toEqual({
		email: "a+b@example.com",
		code: "012345",
	});
});

test("malformed sign-in links are ignored", () => {
	expect(readSignInLink("")).toBeNull();
	expect(readSignInLink("#email=a%40example.com&code=12345")).toBeNull();
	expect(readSignInLink("#email=a%40example.com&code=abcdef")).toBeNull();
	expect(readSignInLink("#code=012345")).toBeNull();
});
