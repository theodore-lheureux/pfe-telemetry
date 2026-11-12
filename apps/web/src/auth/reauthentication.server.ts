import { accountContextHeader } from "./account-context";
import type { createAuth } from "./create-auth.server";
import { readAuthSession } from "./session.server";

type Auth = ReturnType<typeof createAuth>;
const paths = {
	send: "/email-otp/send-verification-otp",
	email: "/sign-in/email-otp",
	passkey: "/passkey/verify-authentication",
	totp: "/two-factor/verify-totp",
	backup: "/two-factor/verify-backup-code",
} as const;

function reply(status: number, body: object, cookies: string[] = []) {
	const headers = new Headers({ "Cache-Control": "private, no-store" });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return Response.json(body, { status, headers });
}

/** The request's JSON object, or the response rejecting it. */
async function readInput(
	request: Request,
): Promise<Record<string, unknown> | Response> {
	try {
		const body = await request.text();
		if (body.length > 32768) return reply(413, { code: "INVALID_INPUT" });
		const input = JSON.parse(body);
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error();
		return input;
	} catch {
		return reply(400, { code: "INVALID_INPUT" });
	}
}

type Session = NonNullable<Awaited<ReturnType<typeof readAuthSession>>>;
type AuthContext = Awaited<Auth["$context"]>;

/**
 * The body for the native verification endpoint of one action, or the response
 * rejecting the input. A passkey must belong to the signed-in account.
 */
async function verificationBody(
	action: string,
	input: Record<string, unknown>,
	current: Session,
	context: AuthContext,
): Promise<object | Response> {
	if (action === "send") return { email: current.user.email, type: "sign-in" };
	if (action === "email") {
		if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
			return reply(400, { code: "INVALID_OTP" });
		return { email: current.user.email, otp: input.code };
	}
	if (action === "passkey") {
		const response = input.response;
		if (
			!response ||
			typeof response !== "object" ||
			!("id" in response) ||
			typeof response.id !== "string"
		)
			return reply(400, { code: "INVALID_INPUT" });
		const credential = await context.adapter.findOne({
			model: "passkey",
			where: [
				{ field: "credentialID", value: response.id },
				{ field: "userId", value: current.user.id },
			],
		});
		if (!credential) return reply(403, { code: "ACCOUNT_CHANGED" });
		return { response };
	}
	if (
		!current.user.twoFactorEnabled ||
		typeof input.code !== "string" ||
		input.code.length > 32
	)
		return reply(400, { code: "INVALID_INPUT" });
	return { code: input.code, trustDevice: false };
}

export async function handleReauthentication(
	request: Request,
	auth: Auth,
	origin: string,
) {
	if (request.method !== "POST")
		return reply(405, { code: "METHOD_NOT_ALLOWED" });
	if (request.headers.get("origin") !== origin)
		return reply(403, { code: "INVALID_ORIGIN" });
	const input = await readInput(request);
	if (input instanceof Response) return input;
	const action = input.action;
	if (typeof action !== "string" || !Object.hasOwn(paths, action))
		return reply(400, { code: "INVALID_INPUT" });
	const current = await readAuthSession(auth, request.headers, true);
	if (!current?.user.emailVerified) return reply(401, { code: "UNAUTHORIZED" });
	if (input.userId !== current.user.id)
		return reply(403, { code: "ACCOUNT_CHANGED" });
	const context = await auth.$context;
	const sessionCookies = [
		context.authCookies.sessionToken.name,
		context.authCookies.sessionData.name,
		context.authCookies.accountData.name,
	];
	const isSessionCookie = (name: string) =>
		sessionCookies.some(
			(prefix) => name === prefix || name.startsWith(`${prefix}.`),
		);
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.set("content-type", "application/json");
	headers.set(accountContextHeader, current.user.id);
	// Keep the existing browser session until every required factor has succeeded.
	// Native verification must see the challenge, not mistake the old session for proof.
	headers.set(
		"cookie",
		(headers.get("cookie") ?? "")
			.split(";")
			.filter((cookie) => !isSessionCookie(cookie.trim().split("=", 1)[0]))
			.join(";"),
	);
	const body = await verificationBody(action, input, current, context);
	if (body instanceof Response) return body;
	const response = await auth.handler(
		new Request(
			new URL(`/api/auth${paths[action as keyof typeof paths]}`, origin),
			{ method: "POST", headers, body: JSON.stringify(body) },
		),
	);
	const data = await response.json().catch(() => null);
	const cookies = response.headers.getSetCookie();
	const nonSessionCookies = cookies.filter(
		(cookie) => !isSessionCookie(cookie.split("=", 1)[0]),
	);
	if (!response.ok)
		return reply(
			response.status,
			{
				code:
					typeof data?.code === "string" ? data.code : "VERIFICATION_FAILED",
			},
			nonSessionCookies,
		);
	if (action === "send") return reply(200, { sent: true }, nonSessionCookies);
	if (data?.twoFactorRedirect === true)
		return reply(200, { twoFactorRequired: true }, nonSessionCookies);
	if (data?.user?.id !== current.user.id) {
		const token = data?.session?.token ?? data?.token;
		if (typeof token === "string")
			await context.internalAdapter.deleteSession(token);
		return reply(403, { code: "ACCOUNT_CHANGED" });
	}
	return reply(200, { verified: true }, cookies);
}
