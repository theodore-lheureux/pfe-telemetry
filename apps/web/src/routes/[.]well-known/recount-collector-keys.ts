import { createFileRoute } from "@tanstack/react-router";
import { handlePublicKeys } from "../../collectors/collector-api.server";

export const Route = createFileRoute("/.well-known/recount-collector-keys")({
	server: { handlers: { GET: () => handlePublicKeys() } },
});
