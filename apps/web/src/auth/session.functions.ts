import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { getAuth } from "./auth.server";
import { readAuthSession } from "./session.server";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		const session = await readAuthSession(getAuth(), getRequestHeaders());
		return session?.user.emailVerified
			? { id: session.user.id, email: session.user.email }
			: null;
	},
);
