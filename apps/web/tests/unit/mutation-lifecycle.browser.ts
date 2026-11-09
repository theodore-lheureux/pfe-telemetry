import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "Save", exact: true }),
	).toBeEnabled();
});

test("receipt retry uses the exact variables once and never retries automatically", async ({
	page,
}) => {
	await page.getByLabel("Draft").fill("  Original  ");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(1);
	await page.evaluate(() => window.mutationTest.lose(0));
	await page.getByRole("button", { name: "Retry creation" }).waitFor();
	await page.getByLabel("Draft").fill("Different draft");
	await page.getByRole("button", { name: "Retry creation" }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(2);
	const writes = await page.evaluate(() => window.mutationTest.writes());
	expect(writes[0].name).toBe("Original");
	expect(writes[1]).toEqual(writes[0]);
	await page.evaluate(() => window.mutationTest.lose(1));
	await expect(page.getByTestId("outcome")).toContainText("uncertain:");
	await expect(
		page.getByRole("button", { name: "Retry creation" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Save", exact: true }),
	).toBeDisabled();
});

for (const retirement of ["navigation", "identity", "document"] as const) {
	test(`a ${retirement}-retired response cannot publish, reload or navigate later`, async ({
		page,
	}) => {
		await page.evaluate(() => window.mutationTest.navigateAfterSave());
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.writes().length))
			.toBe(1);
		if (retirement === "navigation") {
			await page.getByRole("link", { name: "Other", exact: true }).click();
			await page.getByRole("link", { name: "Editor", exact: true }).click();
		} else
			await page.evaluate((reason) => {
				if (reason === "identity") window.mutationTest.identity();
				else {
					window.dispatchEvent(
						new PageTransitionEvent("pagehide", { persisted: true }),
					);
					window.dispatchEvent(
						new PageTransitionEvent("pageshow", { persisted: true }),
					);
				}
			}, retirement);
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.idle()))
			.toBe(true);
		const reads = await page.evaluate(() => window.mutationTest.reads());
		await page.evaluate(() => window.mutationTest.deliver(0));
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.settled()))
			.toBe(1);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole("link", { name: "Saved link" })).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Dismiss notice" }),
		).toHaveCount(0);
		expect(await page.evaluate(() => window.mutationTest.reads())).toBe(reads);
	});
}

test("a current saved operation can follow its typed destination and release its notice", async ({
	page,
}) => {
	await page.evaluate(() => window.mutationTest.navigateAfterSave());
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(1);
	await page.evaluate(() => window.mutationTest.deliver(0));
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.settled()))
		.toBe(1);
	await expect(page).toHaveURL(/\/account$/);
	await expect(page.getByRole("heading", { name: "Other page" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Dismiss notice" }),
	).toHaveCount(0);
});

for (const reason of ["fragment", "identity", "document"] as const) {
	test(`confirmation belongs to its page and document after ${reason}`, async ({
		page,
	}) => {
		await page.getByRole("button", { name: "Open confirmation" }).click();
		await expect(
			page.getByText("Confirm change", { exact: true }),
		).toBeVisible();
		if (reason === "fragment")
			await page.getByRole("link", { name: "Fragment", exact: true }).click();
		else
			await page.evaluate((reason) => {
				if (reason === "identity") window.mutationTest.identity();
				else
					window.dispatchEvent(
						new PageTransitionEvent("pagehide", { persisted: true }),
					);
			}, reason);
		await expect(page.getByText("Confirm change", { exact: true })).toHaveCount(
			0,
		);
		if (reason === "fragment") {
			await page.goBack();
			await expect(page).toHaveURL(/\/$/);
			await expect(
				page.getByText("Confirm change", { exact: true }),
			).toHaveCount(0);
		}
	});
}

for (const retirement of ["page", "document", "identity"] as const) {
	test(`an acknowledged save cannot resume refresh after ${retirement} retirement`, async ({
		page,
	}) => {
		await page.evaluate(() => {
			window.mutationTest.holdRefresh();
			window.mutationTest.navigateAfterSave();
		});
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.writes().length))
			.toBe(1);
		await page.evaluate(() => window.mutationTest.deliver(0));
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.awaitingRefresh()))
			.toBe(true);
		await expect(page.getByRole("link", { name: "Saved link" })).toBeVisible();
		if (retirement === "page") {
			await page.getByRole("link", { name: "Other", exact: true }).click();
			await page.getByRole("link", { name: "Editor", exact: true }).click();
		} else
			await page.evaluate((reason) => {
				if (reason === "identity") window.mutationTest.identity();
				else
					window.dispatchEvent(
						new PageTransitionEvent("pagehide", { persisted: true }),
					);
			}, retirement);
		await expect(page.getByRole("link", { name: "Saved link" })).toHaveCount(0);
		await expect(page.getByTestId("pending")).toHaveText("false");
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.idle()))
			.toBe(true);
		const url = page.url();
		const reads = await page.evaluate(() => window.mutationTest.reads());
		await page.evaluate(() => window.mutationTest.continueRefresh());
		await expect
			.poll(() => page.evaluate(() => window.mutationTest.settled()))
			.toBe(1);
		expect(await page.evaluate(() => window.mutationTest.refreshResult())).toBe(
			false,
		);
		await expect(page.getByRole("link", { name: "Saved link" })).toHaveCount(0);
		await expect(page.getByTestId("pending")).toHaveText("false");
		await expect(
			page.getByRole("button", { name: "Dismiss notice" }),
		).toHaveCount(0);
		await expect(page).toHaveURL(url);
		expect(await page.evaluate(() => window.mutationTest.reads())).toBe(reads);
		expect(await page.evaluate(() => window.mutationTest.writes().length)).toBe(
			1,
		);
	});
}

test("acknowledgement survives reload-error unmount without marking the write rejected", async ({
	page,
}) => {
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(1);
	await page.evaluate(() => {
		window.mutationTest.failReload();
		window.mutationTest.deliver(0);
	});
	await expect(
		page.getByRole("heading", { name: "Reload failed" }),
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Your change was saved, but",
	);
	expect(await page.evaluate(() => window.mutationTest.writes().length)).toBe(
		1,
	);
});

test("completed acknowledgement and saved link survive a fragment, but not document restoration", async ({
	page,
}) => {
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(1);
	await page.evaluate(() => window.mutationTest.deliver(0));
	await expect(page.getByRole("link", { name: "Saved link" })).toBeVisible();
	await page.getByRole("link", { name: "Fragment", exact: true }).click();
	await expect(page).toHaveURL(/\/#content$/);
	await expect(page.getByRole("link", { name: "Saved link" })).toBeVisible();
	await expect(page.getByTestId("outcome")).toContainText("saved:");
	await page.evaluate(() => {
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		);
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
	});
	await expect(page.getByRole("link", { name: "Saved link" })).toHaveCount(0);
	await expect(page.getByTestId("outcome")).toContainText("saved:");
	expect(await page.evaluate(() => window.mutationTest.writes().length)).toBe(
		1,
	);
});

test("successful route recovery releases a document whose restoration reload failed", async ({
	page,
}) => {
	await page.evaluate(() => {
		window.mutationTest.failReload();
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		);
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		);
	});
	await expect(
		page.getByRole("heading", { name: "Reload failed" }),
	).toBeVisible();
	await page.evaluate(() => window.mutationTest.recoverReload());
	await page.getByRole("link", { name: "Other", exact: true }).click();
	await page.getByRole("link", { name: "Editor", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.writes().length))
		.toBe(1);
	await page.evaluate(() => window.mutationTest.deliver(0));
	await expect
		.poll(() => page.evaluate(() => window.mutationTest.settled()))
		.toBe(1);
});
