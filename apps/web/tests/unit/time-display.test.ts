import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeDisplay } from "../../src/components/time-display";
import {
	dateFromNanoseconds,
	formatCompactTime,
	formatExactTime,
	formatUnixTime,
	timeZoneAbbreviation,
} from "../../src/lib/time-display";

test("time conversions use the timestamp's daylight-saving offset in each zone", () => {
	const summer = new Date("2026-06-23T17:37:00.123Z");
	expect(formatExactTime(summer, "en", "America/New_York")).toContain(
		"1:37:00.123",
	);
	expect(formatExactTime(summer, "fr", "Europe/Paris")).toContain(
		"19:37:00,123",
	);
	expect(timeZoneAbbreviation(summer, "en", "America/New_York")).toBe("EDT");
	expect(
		timeZoneAbbreviation("2026-01-23T17:37:00Z", "en", "America/New_York"),
	).toBe("EST");
});

test("compact calendar dates respect project-zone midnight across DST", () => {
	const now = new Date("2026-03-09T04:30:00Z");
	expect(
		formatCompactTime(
			"2026-03-08T05:30:00Z",
			false,
			now,
			"en",
			"America/New_York",
		),
	).toContain("yesterday");
	expect(
		formatCompactTime(
			"2026-03-09T03:30:00Z",
			false,
			now,
			"en",
			"America/New_York",
		),
	).toContain("yesterday");
	expect(
		formatCompactTime("2026-03-09T03:30:00Z", false, now, "en", "UTC"),
	).toContain("today");
});

test("Unix seconds preserve millisecond and telemetry nanosecond precision, including before the epoch", () => {
	const value = new Date("2026-06-23T17:37:00.123Z");
	const nanoseconds = (BigInt(value.getTime()) * 1000000n + 456789n).toString();
	expect(dateFromNanoseconds(nanoseconds).getTime()).toBe(value.getTime());
	expect(formatUnixTime(value, nanoseconds)).toBe(
		`${Math.floor(value.getTime() / 1000)}.123456789`,
	);
	expect(formatUnixTime(new Date(-1))).toBe("-0.001");
	expect(dateFromNanoseconds("-1").getTime()).toBe(-1);
	expect(formatUnixTime(new Date(-1), "-1")).toBe("-0.000000001");
	expect(formatUnixTime(new Date(1000), "1000000000")).toBe("1");
});

test("server time markup is deterministic without guessing the device zone and invalid dates stay noninteractive", () => {
	const value = new Date("2026-06-23T17:37:00Z");
	const html = renderToStaticMarkup(
		createElement(TimeDisplay, { value, mode: "relative" }),
	);
	expect(html).toContain('dateTime="2026-06-23T17:37:00.000Z"');
	expect(html).toContain("disabled");
	expect(html).not.toContain("ago");
	expect(
		renderToStaticMarkup(createElement(TimeDisplay, { value: "invalid" })),
	).toBe("<span>—</span>");
});
