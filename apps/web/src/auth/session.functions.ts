import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { gravatarUrl } from "../components/avatar.server";
import { getAuth } from "./auth.server";
import { readAuthSession } from "./session.server";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		const session = await readAuthSession(getAuth(), getRequestHeaders());
		return session?.user.emailVerified
			? {
					id: session.user.id,
					email: session.user.email,
					name: session.user.name,
					image: session.user.image,
					gravatarUrl: gravatarUrl(session.user.email),
					twoFactorEnabled: !!session.user.twoFactorEnabled,
				}
			: null;
	},
);
