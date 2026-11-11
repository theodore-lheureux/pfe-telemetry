import {
	LOCALE_KEY,
	langFromPath,
	preferredLocale,
	switchPath,
} from "./locale.mjs";

// Serialize self-contained helpers for both heads; module scripts would run after paint.
export const localeInitializationScript = `(() => {
	const lang = (${langFromPath.toString()})(location.pathname);
	let saved = null;
	try { saved = localStorage.getItem(${JSON.stringify(LOCALE_KEY)}); } catch {}
	const wanted = (${preferredLocale.toString()})(lang, saved, navigator.languages?.[0] ?? navigator.language ?? "");
	if (wanted !== lang) {
		location.replace((${switchPath.toString()})(location.pathname, wanted) + location.search + location.hash);
	}
})();`;
