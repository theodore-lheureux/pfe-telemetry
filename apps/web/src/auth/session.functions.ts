import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { getAuth } from "./auth.server";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		const session = await getAuth().api.getSession({
			headers: getRequestHeaders(),
		});
		return session ? { id: session.user.id, email: session.user.email } : null;
	},
);
