const UNITS = [
	{ unit: "day", ms: 86_400_000 },
	{ unit: "hour", ms: 3_600_000 },
	{ unit: "minute", ms: 60_000 },
	{ unit: "second", ms: 1000 },
] as const;

const two = (value: number) => String(value).padStart(2, "0");

/** Time since an execution started, as a clock reading such as "4:09" or "1:05:09". */
export function formatElapsed(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}:${two(minutes)}:${two(seconds % 60)}`;
	return `${minutes}:${two(seconds % 60)}`;
}

/** A span in its largest unit and the next nonzero one, such as "2 h 5 min". */
export function formatDuration(ms: number, locale: string) {
	const format = (count: number, unit: string) =>
		new Intl.NumberFormat(locale, {
			style: "unit",
			unit,
			unitDisplay: "short",
		}).format(count);
	const index = UNITS.findIndex((entry) => ms >= entry.ms);
	if (index < 0) return format(0, "second");
	const { unit, ms: size } = UNITS[index];
	const parts = [format(Math.floor(ms / size), unit)];
	const next = UNITS[index + 1];
	const rest = next ? Math.floor((ms % size) / next.ms) : 0;
	if (next && rest > 0) parts.push(format(rest, next.unit));
	return parts.join(" ");
}
