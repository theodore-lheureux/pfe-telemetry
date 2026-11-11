import { getLocale, type Locale } from "@recount/i18n/runtime";

export type TimeValue = Date | string | number;

export function timeDate(value: TimeValue) {
	return new Date(value instanceof Date ? value.getTime() : value);
}

function calendarDay(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en", {
		timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(date);
	const field = (name: string) =>
		Number(parts.find((part) => part.type === name)?.value);
	const day = new Date(0);
	day.setUTCFullYear(field("year"), field("month") - 1, field("day"));
	return { ordinal: day.getTime(), year: field("year") };
}

export function formatCompactTime(
	value: TimeValue,
	relative = false,
	now = new Date(),
	locale: Locale = getLocale(),
	timeZone = "UTC",
) {
	const date = timeDate(value);
	if (!Number.isFinite(date.getTime())) return "—";
	const elapsed = now.getTime() - date.getTime();
	const distance = Math.abs(elapsed);
	const relativeFormat = new Intl.RelativeTimeFormat(locale, {
		numeric: "auto",
	});
	if (relative && distance < 60000) return relativeFormat.format(0, "second");
	if (relative && distance < 3600000)
		return relativeFormat.format(-Math.trunc(elapsed / 60000), "minute");
	if (relative && distance < 86400000)
		return relativeFormat.format(-Math.trunc(elapsed / 3600000), "hour");
	if (relative) {
		const [unit, duration] =
			distance < 7 * 86400000
				? (["day", 86400000] as const)
				: distance < 30 * 86400000
					? (["week", 7 * 86400000] as const)
					: distance < 365 * 86400000
						? (["month", 30 * 86400000] as const)
						: (["year", 365 * 86400000] as const);
		return relativeFormat.format(-Math.trunc(elapsed / duration), unit);
	}
	const day = calendarDay(date, timeZone);
	const today = calendarDay(now, timeZone);
	const difference = (day.ordinal - today.ordinal) / 86400000;
	if (difference === 0 || difference === -1)
		return `${relativeFormat.format(difference, "day")}, ${new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(date)}`;
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		month: "short",
		day: "numeric",
		year: day.year === today.year ? undefined : "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

export function formatExactTime(
	value: TimeValue,
	locale: Locale,
	timeZone: string,
) {
	const date = timeDate(value);
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		...(date.getUTCMilliseconds()
			? { fractionalSecondDigits: 3 as const }
			: {}),
	}).format(date);
}

export function timeZoneAbbreviation(
	value: TimeValue,
	locale: Locale,
	timeZone: string,
) {
	return (
		new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
			.formatToParts(timeDate(value))
			.find((part) => part.type === "timeZoneName")?.value ?? timeZone
	);
}

export function dateFromNanoseconds(value: string) {
	const nanoseconds = BigInt(value);
	const milliseconds =
		nanoseconds / 1000000n -
		(nanoseconds < 0n && nanoseconds % 1000000n !== 0n ? 1n : 0n);
	return new Date(Number(milliseconds));
}

export function formatUnixTime(value: TimeValue, nanoseconds?: string) {
	if (nanoseconds === undefined)
		return String(timeDate(value).getTime() / 1000);
	const raw = BigInt(nanoseconds);
	const absolute = raw < 0n ? -raw : raw;
	const fraction = (absolute % 1000000000n)
		.toString()
		.padStart(9, "0")
		.replace(/0+$/, "");
	return `${raw < 0n ? "-" : ""}${absolute / 1000000000n}${fraction ? `.${fraction}` : ""}`;
}
