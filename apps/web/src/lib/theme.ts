import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

export const themeCookie = "recount_theme";

export function parseTheme(value: unknown) {
	return value === "tide-dark" ? "tide-dark" : "tide";
}

export const getInitialTheme = createIsomorphicFn()
	.server(() => parseTheme(getCookie(themeCookie)))
	.client(() => parseTheme(document.documentElement.dataset.theme));
