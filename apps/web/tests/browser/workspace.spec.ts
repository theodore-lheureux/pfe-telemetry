import { eq } from "drizzle-orm";
import { member } from "../../src/db/schema";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import {
	chooseOrganization,
	chooseProject,
	data,
	expect,
	openSettingsSection,
	openWorkspaceMenu,
	settingsUrl,
	test,
} from "./fixtures";

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
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Executions", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "No executions yet", exact: true }),
	).toBeVisible();
	const projectURL = page.url().replace(/\/executions\/?$/, "");
	await openSettingsSection(page, "Project settings");
	await openSettingsSection(page, "Customization");
	await page.getByLabel("Name", { exact: true }).fill("GPU comparison");
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toContainText("GPU comparison");
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"GPU comparison",
	);
	await openWorkspaceMenu(page);
	await page
		.getByRole("menuitem", { name: "Choose project", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "New project", exact: true })
		.click();
	const createProject = page.getByRole("dialog", {
		name: "Create project",
		exact: true,
	});
	await createProject.getByLabel("Project name", { exact: true }).fill("   ");
	await createProject
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		createProject.getByText("Enter a name, not just spaces.", { exact: true }),
	).toBeVisible();
	await createProject
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await openWorkspaceMenu(page);
	await page
		.getByRole("menuitem", { name: "Choose organization", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "New organization", exact: true })
		.click();
	const createOrganization = page.getByRole("dialog", {
		name: "Create organization",
		exact: true,
	});
	await createOrganization
		.getByLabel("Organization name", { exact: true })
		.fill("Second lab");
	await createOrganization
		.getByRole("button", { name: "Create organization", exact: true })
		.click();
	await expect(createOrganization).toHaveCount(0);
	await page.goto(`${projectURL}/executions`);
	// A new organization has no projects, so it opens its empty organization page.
	await chooseOrganization(page, "Second lab");
	await expect(
		page.getByRole("heading", { name: "Second lab", exact: true }),
	).toBeVisible();
	// Returning to an organization reopens its remembered project.
	await chooseOrganization(page, "Research lab");
	await expect(page).toHaveURL(`${projectURL}/executions`);
	await chooseProject(page, "GPU comparison");
	await expect(page).toHaveURL(`${projectURL}/executions`);
	const missing = await page.goto(
		`${projectURL}/executions/not-a-real-execution`,
	);
	expect(missing?.status()).toBe(404);
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	await expect(page.locator("[data-public-header], footer")).toHaveCount(0);
	await page.goto(`${projectURL}/executions`);
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toBeEnabled();
	await page.evaluate(() => {
		document.body.dataset.testDocument = "same-account-transition-document";
	});
	await openSettingsSection(page, "User settings");
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
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.click();
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
		settingsUrl(
			`${workspace.origin}/organizations/private/projects/00000000-0000-0000-0000-000000000000`,
		),
	);
	await expect(page).toHaveURL(/\/login(?:\?|$)/);
	await expect(page.getByLabel("Email address")).toBeEnabled();
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Private lab",
				slug: "private-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Private project",
			}),
		),
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
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(workspace.database.db, actor, {
				organizationId: organization.id,
				projectId: project.id,
				memberId: membership.id,
				role: "viewer",
			}),
		),
	);
	await page.goto(settingsUrl(projectURL));
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toHaveCount(0);
	await page.goto(settingsUrl(projectURL, "collectors"));
	await expect(
		page.getByRole("heading", { name: "Page not found", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create enrollment key", exact: true }),
	).toHaveCount(0);
	await page.goto(settingsUrl(projectURL, "project-customization"));
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toHaveCount(0);
	data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(workspace.database.db, actor, {
				organizationId: organization.id,
				projectId: project.id,
				memberId: membership.id,
				role: "admin",
			}),
		),
	);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toBeVisible();
	await workspace.database.db
		.delete(member)
		.where(eq(member.id, membership.id));
	await page.getByRole("link", { name: "Executions", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
	const inaccessible = await page.goto(settingsUrl(projectURL));
	expect(inaccessible?.status()).toBe(404);
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(settingsUrl(projectURL, "project-customization"));
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toBeVisible();
	const invalid = await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${organization.id}/projects/not-a-uuid`,
		),
	);
	expect(invalid?.status()).toBe(404);
	const crossTenant = await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/another-organization/projects/${project.id}`,
		),
	);
	expect(crossTenant?.status()).toBe(404);
});

test("does not mistake transport failures for empty results and rechecks access after a denied mutation", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Mutation lab",
				slug: "mutation-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Original name",
			}),
		),
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
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(workspace.database.db, actor, {
				organizationId: organization.id,
				projectId: project.id,
				memberId: membership.id,
				role: "admin",
			}),
		),
	);
	const projectURL = `${workspace.origin}/organizations/${organization.id}/projects/${project.id}`;
	await page.goto(settingsUrl(projectURL, "project-customization"));
	await page.route("**/_serverFn/**", (route) =>
		route.request().method() === "POST" ? route.abort() : route.continue(),
	);
	await page.getByLabel("Name", { exact: true }).fill("Unsaved name");
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"The response was lost; the action may have completed.",
	);
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toBeDisabled();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved name",
	);
	await page.unroute("**/_serverFn/**");
	await page.reload();
	await page.getByLabel("Name", { exact: true }).fill("Denied name");
	await expect(
		page.getByRole("button", { name: "Save project", exact: true }),
	).toBeEnabled();
	data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.removeProjectMember(workspace.database.db, actor, {
				organizationId: organization.id,
				projectId: project.id,
				memberId: membership.id,
			}),
		),
	);
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Page not found" }),
	).toBeVisible();
	expect(
		data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.getProject(workspace.database.db, actor, {
					organizationId: organization.id,
					projectId: project.id,
				}),
			),
		).name,
	).toBe("Original name");
});

test("returns passkey sign-in to the validated tenant destination", async ({
	page,
	workspace,
}) => {
	// This case selects the manual action; autofill selection has its own real-verification case.
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{
				configurable: true,
				value: async () => false,
			},
		);
	});
	const owner = await workspace.signIn(page, "passkey@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Passkey lab",
				slug: "passkey-lab",
			}),
		),
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
	await page.goto(settingsUrl(workspace.origin, "user"));
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

test("preserves a local destination through email-code sign-in without SMTP delivery", async ({
	page,
	workspace,
}) => {
	const destination = "/settings?section=user";
	await workspace.enableCodeDelivery(page);
	await page.goto(
		`${workspace.origin}/login?${new URLSearchParams({ redirect: destination })}`,
	);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("return@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await workspace.submitReceivedCode(page, "return@example.invalid");
	await page
		.getByRole("dialog", { name: "Make your next sign-in easier", exact: true })
		.getByRole("button", { name: "Not now", exact: true })
		.click();
	await expect(page).toHaveURL(`${workspace.origin}${destination}`);
	await expect(
		page.getByRole("heading", { name: "Profile", exact: true }),
	).toBeVisible();
});

test("acknowledges a saved mutation when subsequent metadata reads fail, then recovers without another write", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "refresh@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Refresh lab",
				slug: "refresh-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Before refresh",
			}),
		),
	);
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}`,
			"project-customization",
		),
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
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Something went wrong" }),
	).toBeVisible();
	await expect(page.locator("[data-public-header], footer")).toHaveCount(0);
	await expect(page.getByRole("status")).toContainText(
		"Your change was saved, but the page could not refresh.",
	);
	expect(
		data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.getProject(workspace.database.db, actor, {
					organizationId: organization.id,
					projectId: project.id,
				}),
			),
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
