const UNITS = [
	{ unit: "day", ms: 86_400_000 },
	{ unit: "hour", ms: 3_600_000 },
	{ unit: "minute", ms: 60_000 },
	{ unit: "second", ms: 1000 },
] as const;

const format = (count: number, unit: string, locale: string) =>
	new Intl.NumberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "short",
	}).format(count);

/** A span in its largest unit and the next nonzero one, such as "2 h 5 min". */
export function formatDuration(milliseconds: number, locale: string) {
	const index = UNITS.findIndex(({ ms }) => milliseconds >= ms);
	if (index < 0) return format(0, "second", locale);
	const { unit, ms } = UNITS[index];
	const parts = [format(Math.floor(milliseconds / ms), unit, locale)];
	const next = UNITS[index + 1];
	const rest = next ? Math.floor((milliseconds % ms) / next.ms) : 0;
	if (next && rest > 0) parts.push(format(rest, next.unit, locale));
	return parts.join(" ");
}
