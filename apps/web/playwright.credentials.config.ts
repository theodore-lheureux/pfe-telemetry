import { defineConfig } from "@playwright/test";
import workspaceConfig from "./playwright.config";

export default defineConfig(workspaceConfig, {
	testMatch: "collector-credentials.spec.ts",
	timeout: 30_000,
	outputDir: "test-results/credentials-browser",
	use: { channel: "chrome", trace: "off", screenshot: "off", video: "off" },
});
