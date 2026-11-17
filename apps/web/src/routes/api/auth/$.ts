import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../../auth/auth.server";
import { readLandingOrigin } from "../../../auth/config.server";
import { allowLandingSessionCheck } from "../../../auth/landing-session";

let landing: { origin?: string } | undefined;

async function handleAuth(request: Request) {
	const response = await getAuth().handler(request);
	response.headers.set("Cache-Control", "private, no-store");
	landing ??= { origin: readLandingOrigin() };
	allowLandingSessionCheck(request, response, landing.origin);
	return response;
}

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => handleAuth(request),
			POST: ({ request }) => handleAuth(request),
		},
	},
});
