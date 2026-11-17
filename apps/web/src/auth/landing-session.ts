/**
 * Lets the landing site ask whether someone is signed in, to label its links
 * into the app. Only the session read is shared, and only with that origin.
 */
export function allowLandingSessionCheck(
	request: Request,
	response: Response,
	landingOrigin: string | undefined,
) {
	if (
		!landingOrigin ||
		request.method !== "GET" ||
		new URL(request.url).pathname !== "/api/auth/get-session"
	)
		return;
	response.headers.append("Vary", "Origin");
	if (request.headers.get("Origin") !== landingOrigin) return;
	response.headers.set("Access-Control-Allow-Origin", landingOrigin);
	response.headers.set("Access-Control-Allow-Credentials", "true");
}
