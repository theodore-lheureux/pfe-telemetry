import { expect, test } from "bun:test";
import { gravatarUrl } from "../../src/components/avatar.server";
import {
	parseSettingsSearch,
	settingsPath,
} from "../../src/components/settings-links";

test("Gravatar uses normalized SHA256 without raw email or external fallback/profile parameters", () => {
	const url = new URL(gravatarUrl("  Test@example.com  "));
	expect(url.href).toBe(gravatarUrl("test@example.com"));
	expect(url.protocol).toBe("https:");
	expect(url.pathname).toMatch(/^\/avatar\/[a-f0-9]{64}$/);
	expect(url.searchParams.get("d")).toBe("404");
	expect(url.href).not.toContain("example.com");
});

test("one canonical settings URL carries project context across user sections and rejects incomplete scope", () => {
	const selected = {
		organizationId: "fixture-org",
		projectId: "11111111-1111-4111-8111-111111111111",
	};
	for (const section of ["user", "appearance"] as const) {
		const url = new URL(
			settingsPath(section, selected),
			"https://fixture.invalid",
		);
		expect(url.pathname).toBe("/settings");
		expect(parseSettingsSearch(Object.fromEntries(url.searchParams))).toEqual({
			section,
			...selected,
		});
	}
	expect(() =>
		parseSettingsSearch({ section: "user", projectId: selected.projectId }),
	).toThrow();
	expect(() => parseSettingsSearch({ section: "billing" })).toThrow();
});
