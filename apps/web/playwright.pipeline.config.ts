import { defineConfig } from "@playwright/test";
import workspaceConfig from "./playwright.config";

export default defineConfig(workspaceConfig, {
	testIgnore: [],
	testMatch: "execution-pipeline.spec.ts",
	outputDir: "test-results/pipeline",
	timeout: 180_000,
});
