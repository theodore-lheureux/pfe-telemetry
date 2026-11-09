import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

export const currentOrigin = createIsomorphicFn()
	.server(() => getRequestUrl().origin)
	.client(() => window.location.origin);
