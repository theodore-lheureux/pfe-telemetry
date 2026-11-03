import { eq } from "drizzle-orm";
import { member } from "../../src/db/schema";
import { data, expect, test } from "./fixtures";

test("onboards, creates and renames private projects, switches tenants and signs out", async ({
	page,
	workspace,
}) => {
	await workspace.signIn(page, "owner@example.invalid");
	const response = await page.goto(workspace.origin);
	expect(response?.headers()["cache-control"]).toContain("no-store");
	await expect(
		page.getByRole("heading", { name: "Create your first organization" }),
	).toBeVisible();
	await page
		.getByRole("link", { name: "Create organization", exact: true })
		.click();
	await page.getByLabel("Name", { exact: true }).fill("Research lab");
	await page.getByLabel("Slug", { exact: true }).fill("research-lab");
	await page
		.getByRole("button", { name: "Create organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Research lab", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "No visible projects" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Create project", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("GPU benchmarks");
	await page.getByLabel("Slug", { exact: true }).fill("gpu-benchmarks");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Executions", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Execution data is not connected yet"),
	).toBeVisible();
	const projectURL = page.url().replace(/\/executions\/?$/, "");
	await page
		.getByRole("link", { name: "Project settings", exact: true })
		.click();
	await page.getByLabel("Name", { exact: true }).fill("GPU comparison");
	await page.getByRole("button", { name: "Save project" }).click();
	await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "GPU comparison" }),
	).toHaveCount(1);
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"GPU comparison",
	);
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	await expect(
		page.getByRole("link", { name: /GPU comparison/ }),
	).toBeVisible();
	await page.getByRole("link", { name: "Create project", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("Duplicate slug");
	await page.getByLabel("Slug", { exact: true }).fill("gpu-benchmarks");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.getByRole("status")).toHaveText(
		"This slug is already in use. Choose another slug.",
	);
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Duplicate slug",
	);
	await page.getByLabel("Name", { exact: true }).fill("   ");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.locator("#entity-name-error")).toHaveText(
		"Enter a name, not just spaces.",
	);
	await page
		.getByRole("link", { name: "New organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Create organization", exact: true }),
	).toBeVisible();
	await page.getByLabel("Name", { exact: true }).fill("Second lab");
	await page.getByLabel("Slug", { exact: true }).fill("second-lab");
	await page
		.getByRole("button", { name: "Create organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Second lab", exact: true }),
	).toBeVisible();
	await page
		.getByRole("combobox", { name: "Organization", exact: true })
		.selectOption({ label: "Research lab" });
	await page.getByRole("button", { name: "Switch organization" }).click();
	await expect(
		page.getByRole("heading", { name: "Research lab", exact: true }),
	).toBeVisible();
	await page
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption({ label: "GPU comparison" });
	await page.getByRole("button", { name: "Switch project" }).click();
	await expect(page).toHaveURL(`${projectURL}/executions`);
	const missing = await page.goto(
		`${projectURL}/executions/not-a-real-execution`,
	);
	expect(missing?.status()).toBe(404);
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	await page.goto(`${projectURL}/executions`);
	await expect(
		page.getByRole("button", { name: "Switch organization", exact: true }),
	).toBeEnabled();
	await page.evaluate(() => {
		document.body.dataset.testDocument = "same-account-transition-document";
	});
	await page.getByRole("link", { name: /Account/ }).click();
	await expect(
		page.getByRole("heading", { name: "Passkeys", exact: true }),
	).toBeVisible();
	await expect(page.getByText("No passkeys registered yet.")).toBeVisible();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page).toHaveURL(/\/login(?:\?|$)/);
	await page.goBack();
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Email address")).toBeEnabled();
	await workspace.signIn(page, "other@example.invalid");
	await page.getByRole("link", { name: "PFE Telemetry", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Create your first organization" }),
	).toBeVisible();
	await expect(page.getByText("Research lab", { exact: true })).toHaveCount(0);
	await expect(page.locator("body")).toHaveAttribute(
		"data-test-document",
		"same-account-transition-document",
	);
	await page.goBack();
	await expect(page).toHaveURL(/\/login(?:\?|$)/);
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await expect(page.getByText("Research lab", { exact: true })).toHaveCount(0);
	await expect(page.getByText("GPU comparison", { exact: true })).toHaveCount(
		0,
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-test-document",
		"same-account-transition-document",
	);
});

test("protects direct links, uses effective roles and handles membership revocation on sibling navigation", async ({
	page,
	workspace,
}) => {
	await page.goto(
		`${workspace.origin}/organizations/private/projects/00000000-0000-0000-0000-000000000000/settings`,
	);
	await expect(page).toHaveURL(/\/login(?:\?|$)/);
	await expect(page.getByLabel("Email address")).toBeEnabled();
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Private lab",
			slug: "private-lab",
		}),
	);
	const project = data(
		await workspace.operations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Private project",
			slug: "private-project",
		}),
	);
	const projectURL = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	const viewer = await workspace.signIn(page, "viewer@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: viewer.userId,
			role: "member",
		},
	});
	if (!membership) throw new Error("Expected a membership");
	await page.goto(`${workspace.origin}/organizations/${organization.id}`);
	await expect(
		page.getByRole("heading", { name: "No visible projects" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Create project", exact: true }),
	).toHaveCount(0);
	data(
		await workspace.operations.setProjectMember(owner.headers, {
			organizationId: organization.id,
			projectId: project.id,
			memberId: membership.id,
			role: "viewer",
		}),
	);
	await page.goto(`${projectURL}/settings`);
	await expect(page.getByRole("button", { name: "Save project" })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("link", { name: "Collector credentials" }),
	).toHaveCount(0);
	data(
		await workspace.operations.setProjectMember(owner.headers, {
			organizationId: organization.id,
			projectId: project.id,
			memberId: membership.id,
			role: "admin",
		}),
	);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Save project" }),
	).toBeVisible();
	await workspace.database.db
		.delete(member)
		.where(eq(member.id, membership.id));
	await page.getByRole("link", { name: "Executions", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
	const inaccessible = await page.goto(`${projectURL}/settings`);
	expect(inaccessible?.status()).toBe(404);
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(`${projectURL}/settings`);
	await expect(
		page.getByRole("button", { name: "Save project" }),
	).toBeVisible();
	const invalid = await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/not-a-uuid/settings`,
	);
	expect(invalid?.status()).toBe(404);
	const crossTenant = await page.goto(
		`${workspace.origin}/organizations/another-organization/projects/${project.id}/settings`,
	);
	expect(crossTenant?.status()).toBe(404);
});

test("does not mistake transport failures for empty results and rechecks access after a denied mutation", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Mutation lab",
			slug: "mutation-lab",
		}),
	);
	const project = data(
		await workspace.operations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Original name",
			slug: "original",
		}),
	);
	const editor = await workspace.signIn(page, "editor@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: editor.userId,
			role: "member",
		},
	});
	if (!membership) throw new Error("Expected a membership");
	data(
		await workspace.operations.setProjectMember(owner.headers, {
			organizationId: organization.id,
			projectId: project.id,
			memberId: membership.id,
			role: "admin",
		}),
	);
	const projectURL = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	await page.goto(`${projectURL}/settings`);
	await page.route("**/_serverFn/**", (route) =>
		route.request().method() === "POST" ? route.abort() : route.continue(),
	);
	await page.getByLabel("Name", { exact: true }).fill("Unsaved name");
	await page.getByRole("button", { name: "Save project" }).click();
	await expect(page.getByRole("status")).toContainText(
		"We could not complete the request.",
	);
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved name",
	);
	await page.unroute("**/_serverFn/**");
	data(
		await workspace.operations.removeProjectMember(owner.headers, {
			organizationId: organization.id,
			projectId: project.id,
			memberId: membership.id,
		}),
	);
	await page.getByRole("button", { name: "Save project" }).click();
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	expect(
		data(
			await workspace.operations.getProject(owner.headers, {
				organizationId: organization.id,
				projectId: project.id,
			}),
		).name,
	).toBe("Original name");
});

test("returns passkey sign-in to the validated tenant destination", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "passkey@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Passkey lab",
			slug: "passkey-lab",
		}),
	);
	const destination = `/organizations/${organization.id}`;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await page.goto(`${workspace.origin}/account`);
	await page
		.getByLabel("Passkey name", { exact: true })
		.fill("Browser test key");
	await page
		.getByRole("button", { name: "Add a passkey", exact: true })
		.click();
	await expect(
		page.getByText("Browser test key", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await page.goto(
		`${workspace.origin}/login?${new URLSearchParams({ redirect: destination })}`,
	);
	await page
		.getByRole("button", { name: "Sign in with a passkey", exact: true })
		.click();
	await expect(page).toHaveURL(`${workspace.origin}${destination}`);
	await expect(
		page.getByRole("heading", { name: "Passkey lab", exact: true }),
	).toBeVisible();
});

test("preserves a local destination through magic-link sign-in without SMTP delivery", async ({
	page,
	workspace,
}) => {
	const destination = "/account";
	await page.route("**/api/auth/sign-in/magic-link", async (route) => {
		const request = route.request();
		const body = request.postDataJSON();
		expect(body.callbackURL).toBe(destination);
		expect(body.newUserCallbackURL).toBe(destination);
		expect(
			new URL(body.errorCallbackURL, workspace.origin).searchParams.get(
				"redirect",
			),
		).toBe(destination);
		const response = await workspace.auth.handler(
			new Request(request.url(), {
				method: "POST",
				headers: request.headers(),
				body: request.postData(),
			}),
		);
		await route.fulfill({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.text(),
		});
	});
	await page.goto(
		`${workspace.origin}/login?${new URLSearchParams({ redirect: destination })}`,
	);
	await page.getByLabel("Email address").fill("magic@example.invalid");
	await page.getByRole("button", { name: "Email me a sign-in link" }).click();
	await expect(page.getByRole("status")).toContainText("a link is on its way");
	const link = workspace.links.get("magic@example.invalid");
	if (!link) throw new Error("Expected an in-memory sign-in link");
	await page.goto(link);
	await expect(page).toHaveURL(`${workspace.origin}${destination}`);
	await expect(
		page.getByRole("heading", { name: "Account security", exact: true }),
	).toBeVisible();
});

test("acknowledges a saved mutation when subsequent metadata reads fail, then recovers without another write", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "refresh@example.invalid");
	const organization = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Refresh lab",
			slug: "refresh-lab",
		}),
	);
	const project = data(
		await workspace.operations.createProject(owner.headers, {
			organizationId: organization.id,
			name: "Before refresh",
			slug: "refresh",
		}),
	);
	await page.goto(
		`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/settings`,
	);
	let writes = 0;
	await page.route("**/_serverFn/**", (route) => {
		if (route.request().method() === "POST") {
			writes++;
			return route.continue();
		}
		return route.abort();
	});
	await page
		.getByLabel("Name", { exact: true })
		.fill("Saved despite refresh failure");
	await page.getByRole("button", { name: "Save project" }).click();
	await expect(
		page.getByRole("heading", { name: "Something went wrong" }),
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Your change was saved, but the page could not refresh.",
	);
	expect(
		data(
			await workspace.operations.getProject(owner.headers, {
				organizationId: organization.id,
				projectId: project.id,
			}),
		).name,
	).toBe("Saved despite refresh failure");
	expect(writes).toBe(1);
	await page.unroute("**/_serverFn/**");
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Saved despite refresh failure",
	);
	expect(writes).toBe(1);
});
