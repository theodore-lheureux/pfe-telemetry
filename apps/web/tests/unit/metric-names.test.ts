import { expect, test } from "bun:test";

test("collector metric names are data, not web application logic", async () => {
	const catalog = await Bun.file(
		new URL(
			"../../../../crates/telemetry-validation/src/catalogue.rs",
			import.meta.url,
		),
	).text();
	const metrics = new Set(
		[...catalog.matchAll(/^\s+[A-Z][A-Z_0-9]+ => \("([^"]+)"/gm)].map(
			([, name]) => name,
		),
	);
	expect(metrics.size).toBeGreaterThan(30);
	const src = new URL("../../src/", import.meta.url);
	const files = new Bun.Glob("**/*.{ts,tsx,json}");
	const leaked: string[] = [];
	for await (const path of files.scan({ cwd: src.pathname })) {
		if (path === "analytics/metric-names.ts") continue;
		const text = await Bun.file(new URL(path, src)).text();
		for (const token of new Set(text.match(/[\w.-]+/g))) {
			if (metrics.has(token)) leaked.push(`${path}: ${token}`);
		}
	}
	expect(leaked).toEqual([]);
});
