import { defineConfig } from "@playwright/test";

const port = Number(process.env.RECOUNT_DEVELOPER_BROWSER_PORT ?? 3965);
export default defineConfig({
	testDir: ".",
	testMatch: "developer-toolbar.browser.ts",
	workers: 1,
	fullyParallel: false,
	timeout: 30_000,
	reporter: "list",
	outputDir: "../../test-results/developer-toolbar",
	use: {
		browserName: "chromium",
		baseURL: `http://127.0.0.1:${port}`,
		trace: "off",
	},
	webServer: {
		command: "bun --no-env-file tests/unit/developer-toolbar.server.ts",
		cwd: "../..",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
	},
});
