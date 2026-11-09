import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { readAuthenticationState } from "./authentication-state.server";

export const getAuthenticationState = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		return readAuthenticationState(getRequestHeaders());
	},
);
