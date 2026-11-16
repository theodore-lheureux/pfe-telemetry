import { isRatioMetric } from "../analytics/metric-names";
import { type FormattedNumber, formatNumeric } from "../lib/number-format";

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

/** UCUM annotations such as `{process}` only name what a count counts. */
const suffix = (unit: string) =>
	!unit || unit === "1" || /^\{[^}]*\}$/.test(unit) ? "" : ` ${unit}`;

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
const FREQUENCY_UNITS = ["Hz", "kHz", "MHz", "GHz", "THz"];

/** Seconds in the largest unit that keeps the number readable. */
function duration(seconds: number, format: (value: number) => FormattedNumber) {
	const absolute = Math.abs(seconds);
	let value = seconds / 3600,
		unit = "h";
	if (absolute < 1) {
		value = seconds * 1000;
		unit = "ms";
	} else if (absolute < 120) {
		value = seconds;
		unit = "s";
	} else if (absolute < 7200) {
		value = seconds / 60;
		unit = "min";
	}
	const formatted = format(value);
	return { ...formatted, text: `${formatted.text} ${unit}` };
}

/** Readable measurement text; `exact` keeps the stored value and unit for tooltips. */
export function formatMeasurement(
	value: string | number,
	unit: string,
	locale: string,
	minimumFractionDigits = 0,
	metricName = "",
) {
	const exact = `${activityNumberFormat(locale)(value)}${suffix(unit)}`;
	const number = typeof value === "string" ? Number(BigInt(value)) : value;
	const short = (value: number) =>
		formatNumeric(
			value,
			locale,
			{ maximumFractionDigits: 1 },
			minimumFractionDigits,
		);
	if (unit === "%" || (unit === "1" && isRatioMetric(metricName))) {
		const ratio = unit === "1" ? number : number / 100;
		return {
			...formatNumeric(
				ratio,
				locale,
				{ style: "percent", maximumFractionDigits: 1 },
				minimumFractionDigits,
			),
			exact,
		};
	}
	if (unit === "By" || unit === "By/s") {
		let scaled = number,
			index = 0;
		while (Math.abs(scaled) >= 1024 && index < BYTE_UNITS.length - 1) {
			scaled /= 1024;
			index++;
		}
		const formatted = short(scaled);
		return {
			...formatted,
			text: `${formatted.text} ${BYTE_UNITS[index]}${unit === "By/s" ? "/s" : ""}`,
			exact,
		};
	}
	if (unit === "s") {
		return { ...duration(number, short), exact };
	}
	if (unit === "Hz") {
		let scaled = number;
		let index = 0;
		while (Math.abs(scaled) >= 1000 && index < FREQUENCY_UNITS.length - 1) {
			scaled /= 1000;
			index++;
		}
		const formatted = short(scaled);
		return {
			...formatted,
			text: `${formatted.text} ${FREQUENCY_UNITS[index]}`,
			exact,
		};
	}
	const formatted = formatNumeric(
		typeof value === "string" ? BigInt(value) : value,
		locale,
		typeof value === "string" ? {} : { maximumSignificantDigits: 17 },
		minimumFractionDigits,
	);
	return {
		...formatted,
		text: `${formatted.text}${suffix(unit === "Cel" ? "°C" : unit)}`,
		exact,
	};
}
