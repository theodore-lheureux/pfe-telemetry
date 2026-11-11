import { expect, test } from "bun:test";
import { formatDate } from "@recount/i18n";
import {
	changedProjectTags,
	parseProjectCustomization,
} from "../../src/organizations/project-customization";

const reference = {
	organizationId: "organization",
	projectId: "11111111-1111-4111-8111-111111111111",
};

test("project settings validate tags, groups, IANA zones and week boundaries", () => {
	expect(
		parseProjectCustomization({
			...reference,
			action: "add-tag",
			tag: "  production  ",
		}),
	).toMatchObject({ tag: "production" });
	expect(
		changedProjectTags(["Production"], {
			action: "add-tag",
			tag: "production",
		}),
	).toEqual(["Production"]);
	expect(
		changedProjectTags(["Production"], {
			action: "remove-tag",
			tag: "production",
		}),
	).toEqual([]);
	for (const patch of [
		{ action: "add-tag", tag: "x".repeat(41) },
		{ action: "group", projectGroup: "x".repeat(81) },
		{ action: "time-zone", timeZone: "+01:00" },
		{ action: "time-zone", timeZone: "Fake/Zone" },
		{ action: "week-start", weekStartsOn: 2 },
		{ action: "week-start", weekStartsOn: 6 },
	])
		expect(() =>
			parseProjectCustomization({ ...reference, ...patch }),
		).toThrow();
	expect(() =>
		changedProjectTags(
			Array.from({ length: 20 }, (_, index) => `tag-${index}`),
			{ action: "add-tag", tag: "another" },
		),
	).toThrow();
	for (const weekStartsOn of [0, 1])
		expect(
			parseProjectCustomization({
				...reference,
				action: "week-start",
				weekStartsOn,
			}),
		).toMatchObject({ weekStartsOn });
});

test("project display dates honor zone and DST without changing absolute timestamps", () => {
	const winter = new Date("2026-01-15T12:00:00Z");
	const summer = new Date("2026-07-15T12:00:00Z");
	expect(formatDate(winter, "en", "America/Toronto")).toContain("07:00:00");
	expect(formatDate(summer, "en", "America/Toronto")).toContain("08:00:00");
	expect(formatDate(winter, "fr", "UTC")).toContain("12:00:00");
	expect(winter.toISOString()).toBe("2026-01-15T12:00:00.000Z");
});
