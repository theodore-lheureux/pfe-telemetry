import { createFileRoute } from "@tanstack/react-router";
import { activityStream } from "../../../activity/live-stream.server";

export const Route = createFileRoute("/api/activity/live")({
	server: { handlers: { GET: ({ request }) => activityStream(request) } },
});
