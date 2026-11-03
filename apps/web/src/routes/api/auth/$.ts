import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../../auth/auth.server";

async function handleAuth(request: Request) {
	const response = await getAuth().handler(request);
	response.headers.set("Cache-Control", "private, no-store");
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
