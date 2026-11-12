export function activityNumberFormat(locale: string) {
	const integers = new Intl.NumberFormat(locale);
	const scalars = new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 17,
	});
	return (value: string | number) =>
		typeof value === "string"
			? integers.format(BigInt(value))
			: scalars.format(value);
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/** Readable measurement text; `exact` keeps the stored value and unit for tooltips. */
/** Seconds in the largest unit that keeps the number readable. */
function duration(seconds: number, format: Intl.NumberFormat) {
	const absolute = Math.abs(seconds);
	if (absolute < 1) return `${format.format(seconds * 1000)} ms`;
	if (absolute < 120) return `${format.format(seconds)} s`;
	if (absolute < 7200) return `${format.format(seconds / 60)} min`;
	return `${format.format(seconds / 3600)} h`;
}

export function formatMeasurement(
	value: string | number,
	unit: string,
	locale: string,
) {
	const exact = `${activityNumberFormat(locale)(value)}${unit && unit !== "1" ? ` ${unit}` : ""}`;
	const number = typeof value === "string" ? Number(BigInt(value)) : value;
	const short = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
	if (unit === "By") {
		let scaled = number,
			index = 0;
		while (Math.abs(scaled) >= 1024 && index < BYTE_UNITS.length - 1) {
			scaled /= 1024;
			index++;
		}
		return { text: `${short.format(scaled)} ${BYTE_UNITS[index]}`, exact };
	}
	if (unit === "s") {
		return { text: duration(number, short), exact };
	}
	return { text: exact, exact };
}
