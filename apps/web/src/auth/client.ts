import { passkeyClient } from "@better-auth/passkey/client";
import {
	emailOTPClient,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [
		passkeyClient(),
		organizationClient(),
		emailOTPClient(),
		twoFactorClient(),
	],
});
