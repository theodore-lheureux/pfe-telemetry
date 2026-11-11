import { createFileRoute } from "@tanstack/react-router";
import { handleToken } from "../../../collectors/collector-api.server";

export const Route = createFileRoute("/api/collectors/token")({
	server: { handlers: { POST: ({ request }) => handleToken(request) } },
});
