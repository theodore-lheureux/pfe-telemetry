/** @typedef {"en" | "fr"} Lang */

/** @type {readonly Lang[]} */
export const LANGS = ["en", "fr"];
export const LOCALE_KEY = "recount-locale";

/** @param {string} pathname @returns {Lang} */
export function langFromPath(pathname) {
	return pathname === "/fr" || pathname.startsWith("/fr/") ? "fr" : "en";
}

/** @param {Lang} lang @param {string} path */
export function localePath(lang, path) {
	return lang === "en" ? path : `/fr${path}`;
}

/** @param {string} pathname @param {Lang} to */
export function switchPath(pathname, to) {
	const base = pathname.replace(/^\/fr(?=\/|$)/, "") || "/";
	return to === "en" ? base : `/fr${base}`;
}

/** @param {Lang} current @param {string | null} saved @param {string} systemLanguage @returns {Lang} */
export function preferredLocale(current, saved, systemLanguage) {
	if (saved === "en" || saved === "fr") return saved;
	// An explicit French URL wins over system language, but not a saved choice.
	if (current === "fr") return current;
	return systemLanguage.toLowerCase().startsWith("fr") ? "fr" : "en";
}
