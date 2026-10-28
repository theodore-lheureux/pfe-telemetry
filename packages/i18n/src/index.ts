import {
	extractLocaleFromRequest,
	getLocale,
	type Locale,
} from "./paraglide/runtime.js";

export type { Locale } from "./paraglide/runtime.js";

export function requestLocale(headers?: Headers): Locale {
	return extractLocaleFromRequest(
		new Request("https://locale.invalid", { headers }),
	);
}

export function formatDate(
	value: string | Date | number,
	locale: Locale = getLocale(),
) {
	// Combined date/time connectors differ across server and browser ICU releases.
	const date = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeZone: "UTC",
	}).format(new Date(value));
	return `${date} ${formatTime(new Date(value).getTime(), locale)}`;
}

export function formatNumber(value: number, locale: Locale = getLocale()) {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
		value,
	);
}

export function formatSeconds(value: number, locale: Locale = getLocale()) {
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit: "second",
		unitDisplay: "long",
		maximumFractionDigits: 3,
	}).format(value);
}

export function formatTime(value: number, locale: Locale = getLocale()) {
	return new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	}).format(value);
}
