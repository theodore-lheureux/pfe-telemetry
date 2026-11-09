import { isIP } from "node:net";
import Bowser from "bowser";

export function sessionSignInMethod(path?: string) {
	if (path === "/sign-in/email-otp") return "email-otp";
	if (path === "/passkey/verify-authentication") return "passkey";
	if (
		path === "/two-factor/verify-totp" ||
		path === "/two-factor/verify-backup-code"
	)
		return "email-otp";
	return undefined;
}

export function sessionDevice(userAgent?: string | null) {
	if (!userAgent) return null;
	const parsed = Bowser.parse(userAgent.slice(0, 1024));
	if (!parsed.browser.name) return null;
	const browser = [parsed.browser.name, parsed.browser.version?.split(".")[0]]
		.filter(Boolean)
		.join(" ");
	return [browser, parsed.os.name].filter(Boolean).join(" · ");
}

export function sessionLocation(ip?: string | null) {
	if (!ip || !isIP(ip)) return { kind: "unknown" as const };
	const address = ip.toLowerCase();
	const parts = address
		.replace(/^::ffff:/, "")
		.split(".")
		.map(Number);
	const local =
		address === "::1" ||
		address.startsWith("fc") ||
		address.startsWith("fd") ||
		/^fe[89ab][0-9a-f]:/.test(address) ||
		parts[0] === 127 ||
		parts[0] === 10 ||
		(parts[0] === 192 && parts[1] === 168) ||
		(parts[0] === 169 && parts[1] === 254) ||
		(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
	return { kind: local ? ("local" as const) : ("ip" as const), address: ip };
}
