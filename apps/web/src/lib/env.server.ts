import * as z from "zod";

export type Env = Record<string, string | undefined>;

/**
 * Parses environment settings, throwing one error that lists every invalid variable.
 * Messages name variables only, never their values, since many are secrets.
 */
export function readEnv<T extends z.ZodType>(schema: T, env: Env): z.output<T> {
	const result = schema.safeParse(env);
	if (result.success) return result.data;
	throw new Error(
		[...new Set(result.error.issues.map((issue) => issue.message))].join("; "),
	);
}

export function integer(name: string, min: number, max: number) {
	const error = `${name} must be an integer from ${min} to ${max}`;
	return z
		.string({ error })
		.regex(/^\d+$/, { error })
		.transform(Number)
		.pipe(z.number().min(min, { error }).max(max, { error }));
}

export function secret(name: string, length = 32) {
	const error = `${name} must contain at least ${length} characters`;
	return z.string({ error }).min(length, { error });
}

export function flag(name: string) {
	return z
		.enum(["true", "false"], { error: `${name} must be true or false` })
		.transform((value) => value === "true");
}

/** An http(s) URL without credentials; `root` also forbids a path, query or fragment. */
export function httpUrl(name: string, { root = false } = {}) {
	const error = root
		? `${name} must be an http(s) origin without credentials or a path`
		: `${name} must be an http(s) URL without credentials`;
	return z.url({ protocol: /^https?$/, error }).refine((value) => {
		const url = new URL(value);
		if (url.username || url.password) return false;
		return !root || (url.pathname === "/" && !url.search && !url.hash);
	}, error);
}
