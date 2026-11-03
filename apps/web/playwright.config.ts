import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	fullyParallel: false,
	workers: 1,
	timeout: 45_000,
	reporter: "list",
	outputDir: join(tmpdir(), "opencode/pfe-overnight/pfe54-browser"),
	use: { browserName: "chromium", trace: "off" },
});
