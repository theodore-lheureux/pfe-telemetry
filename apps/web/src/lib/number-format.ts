export interface FormattedNumber {
	text: string;
	fractionDigits: number;
}

/** Pad localized number parts without changing rounding or significant digits. */
export function formatNumeric(
	value: number | bigint,
	locale: string,
	options: Intl.NumberFormatOptions,
	minimumFractionDigits = 0,
): FormattedNumber {
	const parts = new Intl.NumberFormat(locale, options).formatToParts(value);
	const fraction = parts.find((part) => part.type === "fraction");
	const digits = Array.from(fraction?.value ?? "").length;
	if (minimumFractionDigits > digits) {
		const symbols = new Intl.NumberFormat(locale, {
			useGrouping: false,
			minimumFractionDigits: 1,
		}).formatToParts(0);
		const zero = symbols.find((part) => part.type === "integer")?.value ?? "0";
		const padding = zero.repeat(minimumFractionDigits - digits);
		if (fraction) {
			fraction.value += padding;
		} else {
			const integer = parts.map((part) => part.type).lastIndexOf("integer");
			if (integer >= 0)
				parts.splice(
					integer + 1,
					0,
					{
						type: "decimal",
						value:
							symbols.find((part) => part.type === "decimal")?.value ?? ".",
					},
					{ type: "fraction", value: padding },
				);
		}
	}
	return {
		text: parts.map((part) => part.value).join(""),
		fractionDigits: Array.from(
			parts.find((part) => part.type === "fraction")?.value ?? "",
		).length,
	};
}
