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
		const absolute = Math.abs(number);
		const text =
			absolute < 1
				? `${short.format(number * 1000)} ms`
				: absolute < 120
					? `${short.format(number)} s`
					: absolute < 7200
						? `${short.format(number / 60)} min`
						: `${short.format(number / 3600)} h`;
		return { text, exact };
	}
	return { text: exact, exact };
}
