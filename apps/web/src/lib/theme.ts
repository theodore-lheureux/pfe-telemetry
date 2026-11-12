import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

export const themeCookie = "recount_theme";
export type ThemeMode = "light" | "dark" | "system";
export type Theme = "system" | "tide-dark" | "tide";

export function parseTheme(value: unknown): Theme {
	if (value === "system" || value === "tide-dark") return value;
	return "tide";
}

export const getInitialTheme = createIsomorphicFn()
	.server(() => parseTheme(getCookie(themeCookie)))
	.client(() => parseTheme(document.documentElement.dataset.theme));
