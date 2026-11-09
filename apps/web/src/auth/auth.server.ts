import { getDatabase } from "../db/client.server";
import {
	sendOrganizationInvitation,
	sendSignInCode,
} from "../email/send.server";
import { readAuthConfig } from "./config.server";
import { createAuth } from "./create-auth.server";
import { processAuthEmailDelivery } from "./email-delivery.server";

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
	if (!auth) {
		const config = readAuthConfig();
		auth = createAuth(
			config,
			getDatabase(),
			{
				sendSignInCode,
				sendOrganizationInvitation,
			},
			processAuthEmailDelivery(),
		);
	}
	return auth;
}
