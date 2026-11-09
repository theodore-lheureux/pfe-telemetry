export function readAuthConfig(env = process.env) {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret || secret.length < 32) {
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
	}
	let url: URL;
	try {
		url = new URL(env.BETTER_AUTH_URL ?? "");
	} catch {
		throw new Error("BETTER_AUTH_URL must be the application's public origin");
	}
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && url.hostname === "localhost"))
	) {
		throw new Error("BETTER_AUTH_URL requires HTTPS, except on localhost");
	}
	if (!["true", "false"].includes(env.RECOUNT_AUTH_ALLOW_SIGN_UP ?? "")) {
		throw new Error("RECOUNT_AUTH_ALLOW_SIGN_UP must be true or false");
	}
	return {
		secret,
		origin: url.origin,
		rpID: url.hostname,
		allowSignUp: env.RECOUNT_AUTH_ALLOW_SIGN_UP === "true",
	};
}

export type AuthConfig = ReturnType<typeof readAuthConfig>;
