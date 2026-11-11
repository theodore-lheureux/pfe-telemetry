import { expect, test } from "bun:test";
import {
	parseTimestamp,
	resolveRange,
} from "../../src/components/date-range/date-range";

// 2026-11-11 06:30 in Montréal, a Wednesday.
const now = new Date("2026-11-11T11:30:00Z");
const zone = "America/Montreal";
const resolve = (range: Parameters<typeof resolveRange>[0], locale = "en") =>
	resolveRange(range, now, zone, locale);

test("relative ranges end now and calendar presets follow the project time zone", () => {
	expect(resolve({ kind: "last", count: 2, unit: "hours" })).toEqual({
		from: new Date("2026-11-11T09:30:00Z"),
	});
	expect(resolve({ kind: "preset", preset: "today" }).from.toISOString()).toBe(
		"2026-11-11T05:00:00.000Z",
	);
	const yesterday = resolve({ kind: "preset", preset: "yesterday" });
	expect(yesterday.from.toISOString()).toBe("2026-11-10T05:00:00.000Z");
	expect(yesterday.to?.toISOString()).toBe("2026-11-11T05:00:00.000Z");
	// Weeks start on Sunday in English (United States) and Monday in French.
	expect(
		resolve(
			{ kind: "preset", preset: "this_week" },
			"en-US",
		).from.toISOString(),
	).toBe("2026-11-08T05:00:00.000Z");
	expect(
		resolve({ kind: "preset", preset: "this_week" }, "fr").from.toISOString(),
	).toBe("2026-11-09T05:00:00.000Z");
	const lastMonth = resolve({ kind: "preset", preset: "last_month" });
	expect(lastMonth.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
	expect(lastMonth.to?.toISOString()).toBe("2026-11-01T04:00:00.000Z");
});

test("jumps center on a timestamp and never end in the future", () => {
	const at = new Date("2026-11-11T10:00:00Z");
	expect(resolve({ kind: "jump", at, minutes: 10, anchor: "around" })).toEqual({
		from: new Date("2026-11-11T09:55:00Z"),
		to: new Date("2026-11-11T10:05:00Z"),
	});
	expect(
		resolve({ kind: "jump", at: now, minutes: 5, anchor: "after" }),
	).toEqual({ from: now });
	expect(parseTimestamp("1794373241")?.toISOString()).toBe(
		"2026-11-11T05:00:41.000Z",
	);
	expect(parseTimestamp("2026-11-11T05:00:41Z")?.getTime()).toBe(1794373241000);
	expect(parseTimestamp("tomorrow")).toBeNull();
});
