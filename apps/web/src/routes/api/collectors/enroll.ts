import { createFileRoute } from "@tanstack/react-router";
import { handleEnroll } from "../../../collectors/collector-api.server";

export const Route = createFileRoute("/api/collectors/enroll")({
	server: { handlers: { POST: ({ request }) => handleEnroll(request) } },
});
