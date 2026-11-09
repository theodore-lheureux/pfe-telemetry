import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testIgnore: ["**/execution-pipeline.spec.ts"],
	fullyParallel: false,
	workers: 1,
	timeout: 45_000,
	reporter: "list",
	outputDir: "test-results/browser",
	forbidOnly: !!process.env.CI,
	use: { browserName: "chromium", trace: "off" },
});
