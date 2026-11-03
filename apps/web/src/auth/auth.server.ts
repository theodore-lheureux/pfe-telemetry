import { getDatabase } from "../db/client.server";
import { sendSignInLink } from "../email/send.server";
import { readAuthConfig } from "./config.server";
import { createAuth } from "./create-auth.server";

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
	if (!auth) {
		const config = readAuthConfig();
		auth = createAuth(config, getDatabase(), sendSignInLink);
	}
	return auth;
}
