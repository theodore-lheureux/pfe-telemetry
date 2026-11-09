export function localRedirect(value: unknown, origin: string): string {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL parser whitespace and control-character normalization.
		/[\\\u0000-\u0020\u007f]/.test(value)
	)
		return "/";
	try {
		const url = new URL(value, origin);
		if (
			url.origin !== origin ||
			url.pathname.startsWith("//") ||
			/%5c/i.test(url.pathname)
		)
			return "/";
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return "/";
	}
}

export function loginSearch(
	search: Record<string, unknown>,
	origin: string,
): {
	redirect: string;
} {
	return {
		redirect: localRedirect(search.redirect, origin),
	};
}
