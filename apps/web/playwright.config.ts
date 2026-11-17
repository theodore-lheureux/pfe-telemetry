import { defineConfig } from "@playwright/test";

export default defineConfig({
	globalSetup: "./tests/browser/production-bundle.ts",
	testDir: "./tests/browser",
	testIgnore: ["**/execution-pipeline.spec.ts"],
	fullyParallel: false,
	// Each test owns its database and server port, so workers only add load.
	workers: Number(process.env.RECOUNT_BROWSER_WORKERS ?? 1),
	timeout: 45_000,
	reporter: "list",
	outputDir: "test-results/browser",
	forbidOnly: !!process.env.CI,
	use: { browserName: "chromium", trace: "off" },
});
