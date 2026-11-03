import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import workspaceConfig from "./playwright.config";

export default defineConfig(workspaceConfig, {
	testMatch: "collector-credentials.spec.ts",
	timeout: 30_000,
	outputDir: join(tmpdir(), "opencode/pfe-overnight/pfe56-browser"),
	use: { channel: "chrome", trace: "off", screenshot: "off", video: "off" },
});
