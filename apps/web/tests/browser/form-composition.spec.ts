import { randomUUID } from "node:crypto";
import { m } from "@pfe/i18n/messages";
import { collectorCredential } from "../../src/db/credentials-schema";
import { data, expect, test } from "./fixtures";

for (const locale of ["en", "fr"] as const) {
	test(`entity fields retain native and associated translated validation in ${locale}`, async ({
		page,
		browser,
		workspace,
	}) => {
		const text = (message: typeof m.name) => message({}, { locale });
		await workspace.signIn(page, "form-owner@example.invalid");
		await page
			.context()
			.addCookies([
				{ name: "pfe_locale", value: locale, url: workspace.origin },
			]);
		await page.goto(`${workspace.origin}/organizations/new`);
		const name = page.getByLabel(text(m.name), { exact: true });
		const slug = page.getByLabel(text(m.slug), { exact: true });
		const submit = page.getByRole("button", {
			name: text(m.create_organization),
			exact: true,
		});
		await expect(submit).toBeEnabled();
		let writes = 0;
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/_serverFn/"))
				writes++;
		});
		await submit.click();
		expect(
			await name.evaluate(
				(input: HTMLInputElement) => input.validity.valueMissing,
			),
		).toBe(true);
		expect(writes).toBe(0);
		await name.fill("   ");
		await slug.fill(`form-${locale}`);
		await submit.click();
		await expect(name).toHaveAttribute("aria-invalid", "true");
		await expect(name).toHaveAttribute("aria-describedby", /entity-name-error/);
		await expect(page.locator("#entity-name-error")).toHaveText(
			text(m.enter_a_name_not_just_spaces),
		);
		expect(writes).toBe(0);

		const noScript = await browser.newContext({
			javaScriptEnabled: false,
			storageState: await page.context().storageState(),
		});
		try {
			const unhydrated = await noScript.newPage();
			await unhydrated.goto(`${workspace.origin}/organizations/new`);
			await expect(
				unhydrated.getByLabel(text(m.name), { exact: true }),
			).toBeDisabled();
			await expect(unhydrated.locator("form").last()).toHaveAttribute(
				"method",
				"post",
			);
			await unhydrated.goto(`${workspace.origin}/login`);
			await expect(unhydrated.getByLabel(text(m.email_address))).toBeDisabled();
			await expect(unhydrated.locator("form")).toHaveAttribute(
				"method",
				"post",
			);
		} finally {
			await noScript.close();
		}

		await name.fill(`Form ${locale}`);
		await submit.click();
		await expect(
			page.getByRole("heading", { name: `Form ${locale}`, exact: true }),
		).toBeVisible();
		expect(writes).toBe(1);
		await expect(
			page.getByText(text(m.your_change_was_saved_refreshing_the_page), {
				exact: true,
			}),
		).toHaveCount(0);
	});
}

test("an abandoned entity save cannot invalidate or navigate away from a newer screen", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "late-entity@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Entity lab",
			slug: "entity-lab",
		}),
	);
	await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/new`,
	);
	let release!: () => void;
	let received!: () => void;
	const responseReady = new Promise<void>((resolve) => {
		received = resolve;
	});
	const responseReleased = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		const response = await route.fetch();
		received();
		await responseReleased;
		await route.fulfill({ response });
	});
	await page.getByLabel("Name", { exact: true }).fill("Late project");
	await page.getByLabel("Slug", { exact: true }).fill("late-project");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await responseReady;
	await page.getByRole("link", { name: /^Account/ }).click();
	await expect(
		page.getByRole("heading", { name: "Account security", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("No passkeys registered yet.", { exact: true }),
	).toBeVisible();
	let reads = 0;
	page.on("request", (request) => {
		if (request.method() === "GET" && request.url().includes("/_serverFn/"))
			reads++;
	});
	const response = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().includes("/_serverFn/"),
	);
	release();
	await (await response).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await expect(page).toHaveURL(`${workspace.origin}/account`);
	await expect(
		page.getByText("Your change was saved. Refreshing the page…", {
			exact: true,
		}),
	).toHaveCount(0);
	expect(reads).toBe(0);
});

test("an acknowledged creation recovers its saved destination after metadata reads fail", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "create-recovery@example.invalid");
	await page.goto(`${workspace.origin}/organizations/new`);
	let writes = 0;
	await page.route("**/_serverFn/**", (route) => {
		if (route.request().method() === "POST") {
			writes++;
			return route.continue();
		}
		return route.abort();
	});
	await page.getByLabel("Name", { exact: true }).fill("Recovered organization");
	await page.getByLabel("Slug", { exact: true }).fill("recovered-organization");
	await page
		.getByRole("button", { name: "Create organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Something went wrong" }),
	).toBeVisible();
	const [saved] = data(
		await workspace.operations.listOrganizations(owner.headers),
	);
	await expect(page).toHaveURL(`${workspace.origin}/organizations/${saved.id}`);
	await expect(page.getByRole("status")).toContainText("Your change was saved");
	await page.unroute("**/_serverFn/**");
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Recovered organization", exact: true }),
	).toBeVisible();
	expect(writes).toBe(1);
});

test("invitation controls stay pending until acknowledged-write reads finish", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(
		page,
		"invitation-pending@example.invalid",
	);
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Pending invitations",
			slug: "pending-invitations",
		}),
	);
	await page.goto(
		`${workspace.origin}/organizations/${organization.id}/members`,
	);
	let ready!: () => void;
	let release!: () => void;
	const readsReady = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const readsReleased = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() === "POST") return route.continue();
		ready();
		await readsReleased;
		await route.continue();
	});
	await page
		.getByLabel("Email address", { exact: true })
		.fill("pending@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await readsReady;
	await expect(
		page.getByRole("button", { name: "Send invitation", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByLabel("Email address", { exact: true }),
	).toBeDisabled();
	release();
	await expect(
		page.getByRole("button", { name: "Send invitation", exact: true }),
	).toBeEnabled();
	await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
		"",
	);
});

test("internal Dates survive SSR hydration and client RPC navigation", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "date-roundtrip@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Dates",
			slug: "dates",
		}),
	);
	const project = data(
		await workspace.operations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Dates project",
			slug: "dates-project",
		}),
	);
	const expiresAt = new Date("2099-06-20T12:30:00.000Z");
	await workspace.database.db.insert(collectorCredential).values({
		id: randomUUID(),
		organizationId: organization.id,
		projectId: project.id,
		name: "Date credential",
		sourceId: "date-source",
		tokenSha256: "a".repeat(64),
		hosts: [],
		requireHostId: false,
		expiresAt,
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/hydration|did not match/i.test(message.text()))
			errors.push(message.text());
	});
	const response = await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/settings/credentials`,
	);
	expect(await response?.text()).toContain(expiresAt.toISOString());
	await expect(
		page.locator(`time[datetime="${expiresAt.toISOString()}"]`),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeEnabled();
	await page
		.getByRole("link", { name: "Project settings", exact: true })
		.click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Dates project",
	);
	await page
		.getByRole("link", { name: "Collector credentials", exact: true })
		.click();
	await expect(
		page.locator(`time[datetime="${expiresAt.toISOString()}"]`),
	).toBeVisible();
	expect(errors).toEqual([]);
});
