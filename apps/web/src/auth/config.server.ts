import * as z from "zod";
import { type Env, flag, httpUrl, readEnv, secret } from "../lib/env.server";

const settings = z.object({
	BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET"),
	BETTER_AUTH_URL: httpUrl("BETTER_AUTH_URL", { root: true }).refine(
		(value) => {
			const url = new URL(value);
			return url.protocol === "https:" || url.hostname === "localhost";
		},
		"BETTER_AUTH_URL requires HTTPS, except on localhost",
	),
	RECOUNT_AUTH_ALLOW_SIGN_UP: flag("RECOUNT_AUTH_ALLOW_SIGN_UP"),
});

export function readAuthConfig(env: Env = process.env) {
	const parsed = readEnv(settings, env);
	const url = new URL(parsed.BETTER_AUTH_URL);
	return {
		secret: parsed.BETTER_AUTH_SECRET,
		origin: url.origin,
		rpID: url.hostname,
		allowSignUp: parsed.RECOUNT_AUTH_ALLOW_SIGN_UP,
	};
}

export type AuthConfig = ReturnType<typeof readAuthConfig>;
