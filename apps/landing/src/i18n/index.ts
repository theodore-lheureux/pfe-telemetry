export const LANGS = ["en", "fr"] as const;
export type Lang = (typeof LANGS)[number];

// Saved language choice; when absent, French systems are sent to the French site.
export const LOCALE_KEY = "recount-locale";

export const LANG_LABELS: Record<Lang, string> = {
	en: "English",
	fr: "Français",
};

// Paths for each language: English at the root, French under /fr/.
export function localePath(lang: Lang, path: string) {
	return lang === "en" ? path : `/fr${path === "/" ? "/" : path}`;
}

export function langFromPath(pathname: string): Lang {
	return pathname === "/fr" || pathname.startsWith("/fr/") ? "fr" : "en";
}

// The same page in the other language.
export function switchPath(pathname: string, to: Lang) {
	const base =
		langFromPath(pathname) === "fr"
			? pathname.replace(/^\/fr(?=\/|$)/, "") || "/"
			: pathname;
	return localePath(to, base);
}

// For pages that exist in both languages: `/` and `/fr/`, `/pricing/` and `/fr/pricing/`, …
export function langPaths() {
	return LANGS.map((lang) => ({
		params: { lang: lang === "en" ? undefined : lang },
		props: { lang },
	}));
}
