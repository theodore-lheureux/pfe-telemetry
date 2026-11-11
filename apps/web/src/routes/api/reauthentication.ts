import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../auth/auth.server";
import { readAuthConfig } from "../../auth/config.server";
import { handleReauthentication } from "../../auth/reauthentication.server";

export const Route = createFileRoute("/api/reauthentication")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleReauthentication(request, getAuth(), readAuthConfig().origin),
		},
	},
});
