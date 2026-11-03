import { expect, test } from "bun:test";
import { APIError } from "better-auth/api";
import { requireVerifiedSession } from "../../src/auth/session-policy";
import { OperationError } from "../../src/organizations/errors";

test("verified-session policy preserves session data and transport-specific failures", () => {
	const verified = {
		user: { id: "actor", emailVerified: true },
		session: { id: "session" },
	};
	expect(
		requireVerifiedSession(verified, () => new Error("Unexpected denial")),
	).toBe(verified);
	for (const session of [null, { user: { emailVerified: false } }]) {
		try {
			requireVerifiedSession(
				session,
				({ code, message, reason }) =>
					new OperationError(code, message, reason),
			);
			throw new Error("Expected denial");
		} catch (error) {
			expect(error).toBeInstanceOf(OperationError);
			expect(error).toMatchObject(
				session
					? { code: "FORBIDDEN", reason: "VERIFIED_EMAIL_REQUIRED" }
					: { code: "UNAUTHENTICATED", reason: undefined },
			);
		}
		try {
			requireVerifiedSession(
				session,
				({ code, message, reason }) =>
					new APIError(
						code === "UNAUTHENTICATED" ? "UNAUTHORIZED" : "FORBIDDEN",
						{ message, ...(reason ? { code: reason } : {}) },
					),
			);
			throw new Error("Expected denial");
		} catch (error) {
			expect(error).toBeInstanceOf(APIError);
			expect(error).toMatchObject(
				session
					? { statusCode: 403, body: { code: "VERIFIED_EMAIL_REQUIRED" } }
					: { statusCode: 401 },
			);
		}
	}
});
