import { expect, test } from "bun:test";
import { formatNumeric } from "../../src/lib/number-format";

test("decimal padding keeps locale symbols, compact suffixes and meaningful small digits", () => {
	expect(formatNumeric(17, "en", { maximumFractionDigits: 1 }, 1).text).toBe(
		"17.0",
	);
	expect(formatNumeric(17, "fr", { maximumFractionDigits: 1 }, 1).text).toBe(
		"17,0",
	);
	expect(formatNumeric(0.0015, "en", { maximumFractionDigits: 4 }, 1)).toEqual({
		text: "0.0015",
		fractionDigits: 4,
	});
	expect(
		formatNumeric(
			1200,
			"en",
			{ notation: "compact", maximumFractionDigits: 1 },
			2,
		).text,
	).toBe("1.20K");
	expect(formatNumeric(17, "ar-EG", {}, 1).text).toBe(
		new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 1 }).format(17),
	);
	const large = 9_007_199_254_740_993n;
	expect(formatNumeric(large, "en", {}, 1).text).toBe(
		new Intl.NumberFormat("en", { minimumFractionDigits: 1 }).format(large),
	);
});
