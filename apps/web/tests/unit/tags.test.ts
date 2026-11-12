import { expect, test } from "bun:test";
import {
	parseTags,
	parseUpdateInsightTags,
} from "../../src/analytics/saved-insights-validation";
import { InputError } from "../../src/lib/input-error";
import {
	addTag,
	normalizeTag,
	withoutTags,
	withTags,
} from "../../src/lib/tags";

test("tags are trimmed, bounded and compared without case", () => {
	expect(normalizeTag("  prod ")).toBe("prod");
	expect(normalizeTag("")).toBeNull();
	expect(normalizeTag("x".repeat(41))).toBeNull();
	expect(normalizeTag("a\u0007b")).toBeNull();
	expect(withTags(["Prod"], ["prod", "linux"])).toEqual(["Prod", "linux"]);
	expect(withoutTags(["Prod", "linux"], ["PROD"])).toEqual(["linux"]);
	expect(addTag(["prod"], "  ")).toBeNull();
	const full = Array.from({ length: 20 }, (_, index) => `t${index}`);
	expect(addTag(full, "one-more")).toBeNull();
	expect(addTag(full, "T0")).toEqual(full);
});

test("insight tags and bulk tag changes are validated", () => {
	expect(parseTags([" cpu ", "CPU", "fleet"])).toEqual(["cpu", "fleet"]);
	expect(() => parseTags(["ok", ""])).toThrow(InputError);
	expect(() =>
		parseTags(Array.from({ length: 21 }, (_, i) => `t${i}`)),
	).toThrow(InputError);
	const reference = {
		organizationId: "org",
		projectId: "11111111-1111-4111-8111-111111111111",
		insightIds: ["22222222-2222-4222-8222-222222222222"],
	};
	expect(
		parseUpdateInsightTags({ ...reference, mode: "add", tags: ["cpu"] }),
	).toMatchObject({ mode: "add", tags: ["cpu"] });
	// Replacing with nothing clears tags; adding or removing nothing is refused.
	expect(
		parseUpdateInsightTags({ ...reference, mode: "replace", tags: [] }).tags,
	).toEqual([]);
	expect(() =>
		parseUpdateInsightTags({ ...reference, mode: "remove", tags: [] }),
	).toThrow(InputError);
	expect(() =>
		parseUpdateInsightTags({ ...reference, mode: "rename", tags: ["a"] }),
	).toThrow(InputError);
});
