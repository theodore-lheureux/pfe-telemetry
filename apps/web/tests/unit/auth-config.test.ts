import { expect, test } from "bun:test";
import { readAuthConfig } from "../../src/auth/config.server";

const secret = "test-only-secret-with-32-characters";

test("browser origins require HTTPS except on localhost", () => {
	const read = (url: string) =>
		readAuthConfig({
			BETTER_AUTH_SECRET: secret,
			BETTER_AUTH_URL: url,
			RECOUNT_AUTH_ALLOW_SIGN_UP: "false",
		});
	expect(read("https://app.recount.cloud").origin).toBe(
		"https://app.recount.cloud",
	);
	expect(read("http://localhost:3000").origin).toBe("http://localhost:3000");
	for (const url of ["http://app.recount.cloud", "http://127.0.0.1:3000"]) {
		expect(() => read(url)).toThrow(
			"BETTER_AUTH_URL requires HTTPS, except on localhost",
		);
	}
});
