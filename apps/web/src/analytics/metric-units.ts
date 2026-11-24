import { m } from "@recount/i18n/messages";
import { getLocale } from "@recount/i18n/runtime";
import { type FormattedNumber, formatNumeric } from "../lib/number-format";

export function exactNumberFormat(locale: string) {
	const integers = new Intl.NumberFormat(locale);
	const scalars = new Intl.NumberFormat(locale, {
		maximumSignificantDigits: 17,
	});
	return (value: string | number) =>
		typeof value === "string"
			? integers.format(BigInt(value))
			: scalars.format(value);
}

export function physicalUnit(unit: string) {
	return unit.replace(/\{[^}]*\}/g, "");
}

function annotation(unit: string) {
	return /\{([^{}]+)\}$/.exec(unit)?.[1];
}

export function ratioScale(unit: string) {
	switch (physicalUnit(unit)) {
		case "1":
		case "s/s":
			return 1;
		case "%":
			return 100;
	}
}

export function unitLabel(unit: string) {
	const physical = physicalUnit(unit);
	if (ratioScale(unit)) return "%";
	if (physical === "By") return m.unit_bytes();
	if (physical === "s") return m.unit_seconds();
	if (physical === "Cel") return "°C";
	return physical || annotation(unit) || "";
}

export function rateUnit(unit: string) {
	const physical = physicalUnit(unit);
	return physical && physical !== "1" ? `${physical}/s` : "";
}

/** Count wording comes from the annotation, not the metric's name or physical unit. */
export function countText(
	unit: string,
	count: string,
	value: number,
	locale: string = getLocale(),
) {
	const one = new Intl.PluralRules(locale).select(value) === "one";
	const inputs = { count };
	const options = {
		locale: locale === "fr" ? ("fr" as const) : ("en" as const),
	};
	switch (annotation(unit)) {
		case "busy_process":
			return one
				? m.histogram_count_busy_one(inputs, options)
				: m.histogram_count_busy_other(inputs, options);
		case "process":
			return one
				? m.histogram_count_processes_one(inputs, options)
				: m.histogram_count_processes_other(inputs, options);
		case "gpu":
			return one
				? m.histogram_count_gpus_one(inputs, options)
				: m.histogram_count_gpus_other(inputs, options);
		case "connection":
			return one
				? m.histogram_count_connections_one(inputs, options)
				: m.histogram_count_connections_other(inputs, options);
		case undefined:
			return one
				? m.histogram_count_observations_one(inputs, options)
				: m.histogram_count_observations_other(inputs, options);
		default:
			return `${count} ${annotation(unit)}`;
	}
}

export function countNoun(unit: string) {
	return countText(unit, "", 2).trim();
}

export function approximateCount(count: number, locale: string) {
	const rounded = Math.round(count);
	const text = new Intl.NumberFormat(locale).format(rounded);
	return rounded === count ? text : `≈${text}`;
}

const suffix = (unit: string) => (unit && unit !== "1" ? ` ${unit}` : "");

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
const FREQUENCY_UNITS = ["Hz", "kHz", "MHz", "GHz", "THz"];

/** Seconds in the largest unit that keeps the number readable. */
function duration(
	seconds: number,
	format: (value: number) => FormattedNumber,
	reference = seconds,
) {
	const absolute = Math.abs(reference);
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
export function formatMetricValue(
	value: string | number,
	storedUnit: string,
	locale: string,
	minimumFractionDigits = 0,
	reference?: number,
) {
	const unit = physicalUnit(storedUnit);
	const exact = `${exactNumberFormat(locale)(value)}${suffix(unit)}`;
	const number = typeof value === "string" ? Number(BigInt(value)) : value;
	const short = (value: number) =>
		formatNumeric(
			value,
			locale,
			{ maximumFractionDigits: 1 },
			minimumFractionDigits,
		);
	const scale = ratioScale(unit);
	if (scale) {
		return {
			...formatNumeric(
				number / scale,
				locale,
				{ style: "percent", maximumFractionDigits: 1 },
				minimumFractionDigits,
			),
			exact,
		};
	}
	if (unit === "By" || unit === "By/s") {
		let scaled = Math.abs(reference ?? number);
		let index = 0;
		while (Math.abs(scaled) >= 1024 && index < BYTE_UNITS.length - 1) {
			scaled /= 1024;
			index++;
		}
		const formatted = short(number / 1024 ** index);
		return {
			...formatted,
			text: `${formatted.text} ${BYTE_UNITS[index]}${unit === "By/s" ? "/s" : ""}`,
			exact,
		};
	}
	if (unit === "s") {
		return { ...duration(number, short, reference), exact };
	}
	if (unit === "Hz") {
		let scaled = Math.abs(reference ?? number);
		let index = 0;
		while (Math.abs(scaled) >= 1000 && index < FREQUENCY_UNITS.length - 1) {
			scaled /= 1000;
			index++;
		}
		const formatted = short(number / 1000 ** index);
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

export function metricValuesFormatter(
	unit: string,
	values: Iterable<number>,
	locale: string,
) {
	let reference = 0;
	for (const value of values) {
		if (Number.isFinite(value))
			reference = Math.max(reference, Math.abs(value));
	}
	return (value: number, digits = 0) =>
		formatMetricValue(value, unit, locale, digits, reference);
}
