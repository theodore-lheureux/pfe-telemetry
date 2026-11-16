import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const directory = process.env.RECOUNT_GPU_EVIDENCE;
const state = process.env.RECOUNT_GPU_BROWSER_STATE;
if (!directory || !state)
	throw new Error("Evidence directory and browser state are required");
const manifest = JSON.parse(
	await readFile(resolve(directory, "project.json"), "utf8"),
);
const capabilities = JSON.parse(
	await readFile(resolve(directory, "capabilities.json"), "utf8"),
);
const browser = await chromium.launch();
try {
	const context = await browser.newContext({
		storageState: state,
		locale: "en-US",
	});
	try {
		const page = await context.newPage();
		await context.addCookies([
			{
				name: "recount_locale",
				value: "en",
				url: process.env.RECOUNT_GPU_WEB_URL,
			},
		]);
		await page.goto(manifest.executionUrl);
		await expect(page.locator("main")).toContainText(manifest.execution, {
			timeout: 30_000,
		});
		await page.screenshot({
			path: resolve(directory, "execution.png"),
			fullPage: true,
		});
		for (const view of manifest.views) {
			await page.goto(view.url);
			const table = page.getByRole("table", { name: "Results", exact: true });
			await expect(table).toBeVisible({ timeout: 30_000 });
			await expect(table.getByRole("row").nth(1)).toBeVisible();
			const text = await table.innerText();
			if (view.name === "pipes")
				for (const pipe of capabilities.supported_pipes)
					await expect(table).toContainText(pipe);
			if (view.name === "pipes")
				for (const pipe of capabilities.unsupported_pipes)
					await expect(table).not.toContainText(pipe);
			if (view.name === "device") await expect(table).toContainText("GPU-");
			if (view.name.startsWith("process-"))
				await expect(table).toContainText(manifest.execution);
			if (view.name === "pipe-status")
				for (const pipe of capabilities.unsupported_pipes) {
					const row = table.getByRole("row").filter({ hasText: pipe });
					await expect(
						row.getByRole("cell", { name: "1", exact: true }),
					).toBeVisible();
				}
			await writeFile(resolve(directory, `${view.name}.txt`), text);
			await page.screenshot({
				path: resolve(directory, `${view.name}.png`),
				fullPage: true,
			});
		}
	} finally {
		await context.close();
	}
} finally {
	await browser.close();
}
