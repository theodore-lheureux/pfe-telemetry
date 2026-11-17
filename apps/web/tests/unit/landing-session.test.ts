import { expect, test } from "bun:test";
import { allowLandingSessionCheck } from "../../src/auth/landing-session";

const landing = "https://recount.cloud";

function check(path: string, origin: string | null, method = "GET") {
	const request = new Request(`https://app.recount.cloud${path}`, {
		method,
		headers: origin ? { Origin: origin } : {},
	});
	const response = new Response("{}");
	allowLandingSessionCheck(request, response, landing);
	return response.headers;
}

test("the landing site may read the session with credentials", () => {
	const headers = check("/api/auth/get-session", landing);
	expect(headers.get("Access-Control-Allow-Origin")).toBe(landing);
	expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
	expect(headers.get("Vary")).toBe("Origin");
});

test("other origins, endpoints and methods are not shared", () => {
	for (const headers of [
		check("/api/auth/get-session", "https://attacker.example"),
		check("/api/auth/get-session", null),
		check("/api/auth/list-sessions", landing),
		check("/api/auth/get-session", landing, "POST"),
	])
		expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("nothing is shared without a configured landing origin", () => {
	const request = new Request(
		"https://app.recount.cloud/api/auth/get-session",
		{
			headers: { Origin: landing },
		},
	);
	const response = new Response("{}");
	allowLandingSessionCheck(request, response, undefined);
	expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
