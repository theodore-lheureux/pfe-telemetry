import { getAuth } from "../auth/auth.server";
import { getDatabase } from "../db/client.server";
import { createCollectorCredentialRequests } from "./credentials.server";

export function getCollectorCredentialRequests() {
	return createCollectorCredentialRequests(getDatabase(), getAuth());
}
