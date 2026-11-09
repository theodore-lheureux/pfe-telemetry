import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { getDatabase } from "../db/client.server";
import { readActor } from "./actor.server";
import { getAuth } from "./auth.server";

export const privateOperation = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		try {
			const request = getRequest();
			const headers = request.headers;
			const auth = getAuth();
			const identity = await readActor(auth, headers);
			return await next({
				context: { database: getDatabase(), auth, request, headers, identity },
			});
		} catch (error) {
			// Start serializes thrown RPC errors, so retain private causes only in server diagnostics.
			console.error("Private application operation failed", error);
			throw new Error("The application operation could not complete");
		}
	},
);
