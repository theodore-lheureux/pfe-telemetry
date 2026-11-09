import { defineConfig } from "@playwright/test";

const port = Number(process.env.RECOUNT_MUTATION_BROWSER_PORT ?? 3964);
export default defineConfig({
	testDir: ".",
	testMatch: "mutation-lifecycle.browser.ts",
	workers: 1,
	fullyParallel: false,
	timeout: 45_000,
	reporter: "list",
	outputDir: "../../test-results/mutation-lifecycle",
	use: {
		browserName: "chromium",
		baseURL: `http://127.0.0.1:${port}`,
		trace: "off",
	},
	webServer: {
		command: "bun --no-env-file tests/unit/mutation-lifecycle.server.ts",
		cwd: "../..",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
	},
});
