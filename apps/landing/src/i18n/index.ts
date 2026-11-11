import { LANGS } from "./locale.mjs";

export {
	LANGS,
	LOCALE_KEY,
	langFromPath,
	localePath,
	switchPath,
} from "./locale.mjs";
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
	en: "English",
	fr: "Français",
};

// For pages that exist in both languages: `/` and `/fr/`, `/pricing/` and `/fr/pricing/`, …
export function langPaths() {
	return LANGS.map((lang) => ({
		params: { lang: lang === "en" ? undefined : lang },
		props: { lang },
	}));
}
