// Sign-in emails link to the login page with the address and code in the URL fragment.
// Fragments are never sent to the server or in Referer headers, so the code stays out of
// access logs. The page fills in the code and the person confirms it; nothing is submitted
// on load, so mail scanners that open links cannot use up the code.

export function signInLinkUrl(origin: string, email: string, code: string) {
	const url = new URL("/login", origin);
	url.hash = new URLSearchParams({ email, code }).toString();
	return url.toString();
}

export function readSignInLink(hash: string) {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	const email = params.get("email")?.trim() ?? "";
	const code = params.get("code") ?? "";
	if (!email || email.length > 254 || !/^\d{6}$/.test(code)) return null;
	return { email, code };
}
