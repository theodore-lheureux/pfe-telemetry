// Worker for recount.cloud. Static pages never reach this code; only /api/* does (see
// `run_worker_first` in wrangler.jsonc).

import { EmailMessage } from "cloudflare:email";

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	DB: {
		prepare(query: string): {
			bind(...values: unknown[]): {
				run(): Promise<{ meta: { changes: number } }>;
			};
		};
	};
	NOTIFY: { send(message: EmailMessage): Promise<void> };
	TURNSTILE_SECRET: string;
	/** Verified Email Routing address that receives new signup notices; optional. */
	NOTIFY_TO?: string;
}

interface Context {
	waitUntil(promise: Promise<unknown>): void;
}

const NOTIFY_FROM = "notify@recount.cloud";

const PRODUCTION_HOST = "recount.cloud";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: Record<string, unknown>, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

async function passedTurnstile(
	token: string,
	ip: string | null,
	secret: string,
) {
	const body = new FormData();
	body.append("secret", secret);
	body.append("response", token);
	if (ip) body.append("remoteip", ip);
	const response = await fetch(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		{ method: "POST", body },
	);
	if (!response.ok) return false;
	const result = (await response.json()) as {
		success?: boolean;
		hostname?: string;
		action?: string;
	};
	return (
		result.success === true &&
		result.hostname === PRODUCTION_HOST &&
		result.action === "notify"
	);
}

// Plain-text notice for a new signup. The address passed EMAIL, so it holds no line breaks.
function signupNotice(to: string, email: string, locale: string) {
	const raw = [
		`From: Recount <${NOTIFY_FROM}>`,
		`To: <${to}>`,
		`Subject: New early access signup: ${email}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@recount.cloud>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		`${email} joined the early access list (language: ${locale}).`,
		"",
	].join("\r\n");
	return new EmailMessage(NOTIFY_FROM, to, raw);
}

async function notify(request: Request, env: Env, context: Context) {
	if (request.method !== "POST")
		return json({ error: "method_not_allowed" }, 405);
	const url = new URL(request.url);
	if (request.headers.get("Origin") !== url.origin)
		return json({ error: "forbidden" }, 403);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: "invalid_request" }, 400);
	}
	const email = String(form.get("email") ?? "")
		.trim()
		.toLowerCase();
	const locale = form.get("locale") === "fr" ? "fr" : "en";
	if (email.length > 254 || !EMAIL.test(email))
		return json({ error: "invalid_email" }, 400);

	// Previews and local runs share the production database binding, so they accept the form
	// without storing anything.
	if (url.hostname !== PRODUCTION_HOST)
		return json({ ok: true, stored: false });

	const token = String(form.get("cf-turnstile-response") ?? "");
	const ip = request.headers.get("CF-Connecting-IP");
	if (!token || !(await passedTurnstile(token, ip, env.TURNSTILE_SECRET)))
		return json({ error: "challenge_failed" }, 403);

	// A repeated address succeeds without revealing that it was already on the list.
	const result = await env.DB.prepare(
		"INSERT INTO signups (email, locale) VALUES (?, ?) ON CONFLICT (email) DO NOTHING",
	)
		.bind(email, locale)
		.run();

	// Notify only for new addresses, after responding; a failed notice never fails the signup.
	if (result.meta.changes > 0 && env.NOTIFY_TO) {
		context.waitUntil(
			env.NOTIFY.send(signupNotice(env.NOTIFY_TO, email, locale)).catch(
				(error) => console.error("Signup notice failed", error),
			),
		);
	}
	return json({ ok: true });
}

export default {
	fetch(request: Request, env: Env, context: Context) {
		if (new URL(request.url).pathname === "/api/notify")
			return notify(request, env, context);
		return env.ASSETS.fetch(request);
	},
};
