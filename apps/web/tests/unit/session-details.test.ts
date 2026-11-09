import { expect, test } from "bun:test";
import {
	sessionDevice,
	sessionLocation,
	sessionSignInMethod,
} from "../../src/auth/session-details.server";
import { formatSessionTime } from "../../src/components/settings/session-time";

test("session metadata describes the recorded browser and IP without inventing location or sign-in methods", () => {
	expect(
		sessionDevice(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
		),
	).toBe("Safari 27 · macOS");
	expect(sessionDevice(null)).toBeNull();
	expect(sessionLocation("127.0.0.1").kind).toBe("local");
	expect(sessionLocation("::1").kind).toBe("local");
	expect(sessionLocation("203.0.113.8")).toEqual({
		kind: "ip",
		address: "203.0.113.8",
	});
	expect(sessionLocation(null)).toEqual({ kind: "unknown" });
	expect(sessionSignInMethod("/sign-in/email-otp")).toBe("email-otp");
	expect(sessionSignInMethod("/passkey/verify-authentication")).toBe("passkey");
	expect(sessionSignInMethod("/get-session")).toBeUndefined();
});

test("profile dates omit seconds and distinguish relative, calendar and missing dates", () => {
	const now = new Date(2026, 10, 9, 12, 0, 0);
	expect(formatSessionTime(now, false, now, "en")).toContain("today");
	expect(
		formatSessionTime(new Date(now.getTime() - 60_000), true, now, "en"),
	).toBe("1 minute ago");
	expect(
		formatSessionTime(new Date(now.getTime() - 60_000), true, now, "fr"),
	).toContain("minute");
	expect(
		formatSessionTime(new Date(now.getTime() + 60_000), true, now, "en"),
	).toBe("in 1 minute");
	expect(formatSessionTime("invalid", false, now, "en")).toBe("—");
});
