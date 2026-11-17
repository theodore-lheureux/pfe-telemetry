import { expect, type Page, test } from "@playwright/test";

test("ordinary users have no entry point or developer reads", async ({
	page,
}) => {
	let reads = 0;
	await page.route("**/fixture-rpc/**", async (route) => {
		reads++;
		await route.fulfill({ json: { data: [], error: null } });
	});
	await page.goto("/?ordinary");
	await expect(
		page.getByRole("button", { name: "Change account" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Recount" })).toHaveCount(0);
	expect(reads).toBe(0);
});

async function openFloatingPanel(page: Page) {
	await page.goto("/");
	await page.addStyleTag({
		content:
			'[data-slot="sheet-content"] { position: fixed; right: 12px; bottom: 12px; width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; animation: none !important; transition: none !important; box-sizing: border-box; }',
	});
	await page.getByRole("button", { name: "Recount" }).click();
	return page.locator('[data-slot="sheet-content"]');
}

test("the open toolbar does not block or dismiss on site interactions", async ({
	page,
}) => {
	const panel = await openFloatingPanel(page);
	await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
	await page.getByRole("textbox", { name: "Site search" }).fill("still usable");
	await page.getByRole("button", { name: "Site action (0)" }).click();
	await expect(
		page.getByRole("button", { name: "Site action (1)" }),
	).toBeVisible();
	await expect(panel).toBeVisible();
	await expect(panel).not.toHaveAttribute("aria-modal", "true");
	await expect(panel).not.toContainText("Secrets stay");
	await expect(panel).not.toContainText("Developer only");
	await expect(panel).not.toContainText("powered by");
});

test("the toolbar can be dragged, remembers its position and stays in the viewport", async ({
	page,
}) => {
	await page.clock.install();
	const panel = await openFloatingPanel(page);
	const handle = page.getByRole("button", { name: "Move toolbar" });
	const before = await panel.boundingBox();
	const grip = await handle.boundingBox();
	if (!before || !grip) throw new Error("Missing toolbar bounds");
	await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		grip.x + grip.width / 2 - 240,
		grip.y + grip.height / 2,
		{ steps: 8 },
	);
	await page.mouse.up();
	// Retire the sensor's release-click guard before clicking another control.
	await page.clock.runFor(100);
	await expect(handle).not.toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 240, 0);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(panel).toHaveCount(0);
	await page.getByRole("button", { name: "Recount" }).click();
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 240, 0);
	await page.setViewportSize({ width: 375, height: 600 });
	await expect
		.poll(async () => {
			const rect = await panel.boundingBox();
			return rect ? rect.x + rect.width : Infinity;
		})
		.toBeLessThanOrEqual(363);
	await expect
		.poll(async () => {
			const rect = await panel.boundingBox();
			return rect ? rect.y + rect.height : Infinity;
		})
		.toBeLessThanOrEqual(588);
});

test("the toolbar supports keyboard movement and Escape cancels a move without closing it", async ({
	page,
}) => {
	await page.clock.install();
	const panel = await openFloatingPanel(page);
	const handle = page.getByRole("button", { name: "Move toolbar" });
	const before = await panel.boundingBox();
	if (!before) throw new Error("Missing toolbar bounds");
	await handle.focus();
	await page.keyboard.press("Space");
	// Keyboard sensors attach their document listeners on the next task.
	await page.clock.runFor(50);
	await expect(handle).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("ArrowLeft");
	await page.clock.runFor(50);
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 25, 0);
	await page.keyboard.press("Space");
	await page.clock.runFor(50);
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 25, 0);
	await page.keyboard.press("Space");
	await page.clock.runFor(50);
	await expect(handle).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("ArrowLeft");
	await page.clock.runFor(50);
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 50, 0);
	await page.keyboard.press("Escape");
	await expect(panel).toBeVisible();
	await expect
		.poll(async () => (await panel.boundingBox())?.x)
		.toBeCloseTo(before.x - 25, 0);
});

test("collapsed developer toolbar is idle, GPU gated, cost confirmation is asynchronous", async ({
	page,
}) => {
	const writes: unknown[] = [];
	let reads = 0;
	let finish: (() => void) | undefined;
	await page.route("**/fixture-rpc/tasks", async (route) => {
		reads++;
		await route.fulfill({ json: { data: [], error: null } });
	});
	await page.route("**/fixture-rpc/run", async (route) => {
		writes.push(route.request().postDataJSON());
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		await route.fulfill({ json: { data: { id: 20 }, error: null } });
	});
	await page.goto("/");
	await expect(page.getByRole("button", { name: "Recount" })).toBeVisible();
	expect(reads).toBe(0);
	await page.getByRole("button", { name: "Recount" }).click();
	await expect(
		page.getByRole("option", { name: "Create GPU collectors" }),
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Queue workflow", exact: true })
		.click();
	await expect(
		page.getByText("I accept compute", { exact: false }),
	).toBeVisible();
	expect(writes).toHaveLength(0);
	const confirm = page
		.getByRole("dialog")
		.last()
		.getByRole("button", { name: /Queue/ });
	await confirm.click();
	await expect(confirm).toBeDisabled();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		action: "create-cpu",
		lab: "",
		confirmed: true,
		count: "1",
	});
	finish?.();
	await expect(
		page.getByText("I accept compute", { exact: false }),
	).toHaveCount(0);
});

test("task output is text, and closing/account changes retire private view", async ({
	page,
}) => {
	let reads = 0;
	await page.route("**/fixture-rpc/tasks", async (route) => {
		reads++;
		await route.fulfill({
			json: {
				data: [
					{
						id: 20,
						action: "list",
						status: "success",
						created: "2026-11-17T12:00:00Z",
					},
				],
				error: null,
			},
		});
	});
	await page.route("**/fixture-rpc/output", (route) =>
		route.fulfill({
			json: {
				data: "[redacted]\n<script>window.injected=true</script>",
				error: null,
			},
		}),
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Recount" }).click();
	await page.getByRole("tab", { name: "Activity" }).click();
	await page.getByRole("button", { name: "#20" }).click();
	await expect(
		page.getByRole("region", { name: "Redacted task output", exact: true }),
	).toContainText("<script>");
	await page.getByPlaceholder("Search output").fill("script");
	expect(await page.evaluate(() => "injected" in window)).toBe(false);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Change account" }).click();
	await expect(page.getByRole("button", { name: "Recount" })).toHaveCount(0);
	await expect(
		page.getByRole("region", { name: "Redacted task output", exact: true }),
	).toHaveCount(0);
	expect(reads).toBeGreaterThan(0);
});

test("load forms expose bounded profiles and durations without the old Create/Configure flag", async ({
	page,
}) => {
	const writes: Record<string, unknown>[] = [];
	await page.route("**/fixture-rpc/run", async (route) => {
		writes.push(route.request().postDataJSON());
		await route.fulfill({ json: { data: { id: 50 }, error: null } });
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Recount" }).click();
	await page.getByLabel("Workflow", { exact: true }).selectOption("configure");
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByLabel("Workflow", { exact: true }).selectOption("load-cpu");
	await page.getByLabel("Lab ID", { exact: true }).fill("demo-load");
	await page.getByLabel("Workload profile").selectOption("cpu-primes");
	await page.getByLabel("Duration", { exact: true }).selectOption("180");
	await expect(page.getByLabel("Fleet", { exact: true })).toHaveCount(0);
	await page
		.getByRole("button", { name: "Queue workflow", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		action: "load-cpu",
		lab: "demo-load",
		workload: "cpu-primes",
		duration: "180",
	});
	expect(writes[0]).not.toHaveProperty("fleet");
	expect(writes[0]).not.toHaveProperty("load");
	await page.getByLabel("Workflow", { exact: true }).selectOption("load-gpu");
	await expect(page.getByLabel("Workload profile")).toHaveValue("gpu-mixed");
	await page.getByLabel("Workload profile").selectOption("gpu-memory");
	await page
		.getByRole("button", { name: "Queue workflow", exact: true })
		.click();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1]).toMatchObject({
		action: "load-gpu",
		workload: "gpu-memory",
	});
	await page
		.getByLabel("Workflow", { exact: true })
		.selectOption("load-status");
	await expect(page.getByLabel("Fleet", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Workload profile")).toHaveCount(0);
});

test("load controls render from the compiled French catalog", async ({
	page,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Missing fixture URL");
	await page
		.context()
		.addCookies([{ name: "recount_locale", value: "fr", url: baseURL }]);
	await page.goto("/");
	await page.getByRole("button", { name: "Recount" }).click();
	await page.getByLabel("Workflow", { exact: true }).selectOption("load-gpu");
	await expect(page.getByLabel("Profil de charge")).toHaveValue("gpu-mixed");
	await expect(
		page.getByRole("option", { name: "Mixte", exact: true }),
	).toBeAttached();
	await expect(
		page.getByLabel("Durée", { exact: true }).locator("option"),
	).toHaveCount(4);
	await page.getByLabel("Workflow", { exact: true }).selectOption("load-cpu");
	await expect(
		page.getByRole("option", { name: "Nombres premiers", exact: true }),
	).toBeAttached();
	await expect(
		page.getByRole("button", {
			name: "Mettre le workflow en file",
			exact: true,
		}),
	).toBeVisible();
});

test("Destroy requires an existing lab and explicit pending confirmation", async ({
	page,
}) => {
	const writes: unknown[] = [];
	let finish: (() => void) | undefined;
	await page.route("**/fixture-rpc/tasks", (route) =>
		route.fulfill({ json: { data: [], error: null } }),
	);
	await page.route("**/fixture-rpc/run", async (route) => {
		writes.push(route.request().postDataJSON());
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		await route.fulfill({ json: { data: { id: 21 }, error: null } });
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Recount" }).click();
	await page.getByLabel("Workflow", { exact: true }).selectOption("destroy");
	await expect(page.getByLabel("Lab ID", { exact: false })).toHaveAttribute(
		"required",
		"",
	);
	await page.getByLabel("Lab ID", { exact: false }).fill("demo-existing");
	await page
		.getByRole("button", { name: "Queue workflow", exact: true })
		.click();
	await expect(
		page.getByText("This permanently deletes", { exact: false }),
	).toBeVisible();
	expect(writes).toHaveLength(0);
	const confirm = page
		.getByRole("dialog")
		.last()
		.getByRole("button", { name: /Queue/ });
	await confirm.click();
	await expect(confirm).toBeDisabled();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toMatchObject({
		action: "destroy",
		lab: "demo-existing",
		confirmed: true,
	});
	finish?.();
	await expect(
		page.getByText("This permanently deletes", { exact: false }),
	).toHaveCount(0);
});

test("workflow drafts survive tab changes and task reads are activity-scoped", async ({
	page,
}) => {
	let reads = 0;
	await page.route("**/fixture-rpc/tasks", async (route) => {
		reads++;
		await route.fulfill({ json: { data: [], error: null } });
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Recount" }).click();
	await page.getByLabel("Lab ID", { exact: true }).fill("demo-my-draft");
	await expect(page.getByRole("option", { name: "15 minutes" })).toBeAttached();
	expect(reads).toBe(0);
	await page.getByRole("tab", { name: "Activity" }).click();
	await expect(page.getByText("No tasks yet")).toBeVisible();
	await expect.poll(() => reads).toBe(1);
	await page.getByRole("tab", { name: "Workflows" }).click();
	await expect(page.getByLabel("Lab ID", { exact: true })).toHaveValue(
		"demo-my-draft",
	);
});
