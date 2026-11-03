import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { invitation, member } from "../../src/db/schema";
import { data, expect, test } from "./fixtures";

async function holdSuccessfulWrite(page: Page) {
	let executed: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		executed = resolve;
	});
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let delivered: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		delivered = resolve;
	});
	let released = false;
	let intercepted = false;
	let reads = 0;
	page.on("request", (request) => {
		if (
			released &&
			request.method() === "GET" &&
			request.url().includes("/_serverFn/")
		)
			reads++;
	});
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST" || intercepted) {
			await route.continue();
			return;
		}
		intercepted = true;
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		executed();
		await gate;
		await route.fulfill({ response });
		delivered();
	});
	return {
		ready,
		get reads() {
			return reads;
		},
		async release() {
			released = true;
			release();
			await finished;
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
		},
	};
}

for (const child of [
	{
		name: "member directory",
		module: "member.functions",
		operation: "listOrganizationMembers",
		project: false,
	},
	{
		name: "invitation list",
		module: "invitation.functions",
		operation: "listInvitations",
		project: false,
	},
	{
		name: "explicit grants",
		module: "organization.functions",
		operation: "listProjectMembers",
		project: true,
	},
	{
		name: "grant candidates",
		module: "member.functions",
		operation: "listProjectGrantCandidates",
		project: true,
	},
]) {
	test(`retains the exact login return when the ${child.name} RPC loses its session`, async ({
		page,
		workspace,
	}) => {
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const org = data(
			await workspace.operations.createOrganization(owner.headers, {
				name: "Expiry lab",
				slug: "expiry-lab",
			}),
		);
		const project = data(
			await workspace.operations.createProject(owner.headers, {
				organizationId: org.id,
				name: "Private",
				slug: "private",
			}),
		);
		const parent = `/organizations/${org.id}${child.project ? `/projects/${project.id}/settings` : ""}`;
		const destination = `${parent}/members`;
		await page.goto(`${workspace.origin}${parent}`);
		await expect(
			page.getByRole("button", { name: "Switch organization", exact: true }),
		).toBeEnabled();
		const rpc = await page.evaluate(
			async ({ module, operation }) =>
				(await import(`/src/organizations/${module}.ts`))[operation]
					.url as string,
			child,
		);
		let expired = false;
		await page.route(
			`${new URL(rpc, workspace.origin).href}*`,
			async (route) => {
				if (expired) {
					await route.continue();
					return;
				}
				expired = true;
				const response = await route.fetch({
					headers: { ...route.request().headers(), cookie: "" },
				});
				await route.fulfill({ response });
			},
		);
		await page
			.getByRole("link", {
				name: child.project ? "Project members" : "Members",
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(/\/login\?redirect=/);
		expect(expired).toBe(true);
		expect(new URL(page.url()).searchParams.get("redirect")).toBe(destination);
		await page.route("**/api/auth/sign-in/magic-link", async (route) => {
			const request = route.request();
			const response = await workspace.auth.handler(
				new Request(request.url(), {
					method: "POST",
					headers: { ...request.headers(), "x-forwarded-for": "192.0.2.63" },
					body: request.postData(),
				}),
			);
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
			});
		});
		await page
			.getByLabel("Email address", { exact: true })
			.fill("owner@example.invalid");
		await page
			.getByRole("button", { name: "Email me a sign-in link", exact: true })
			.click();
		await expect(page.getByRole("status")).toContainText(
			"a link is on its way",
		);
		const link = workspace.links.get("owner@example.invalid");
		if (!link) throw new Error("Expected captured sign-in link");
		expect(new URL(link).searchParams.get("callbackURL")).toBe(destination);
		await page.goto(link);
		await expect(page).toHaveURL(`${workspace.origin}${destination}`);
		await expect(
			page.getByRole("heading", {
				name: child.project ? "Project access" : "Organization members",
				exact: true,
			}),
		).toBeVisible();
	});
}

test("a delayed self-project demotion cannot replace a newer organization page", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const first = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "First lab",
			slug: "first-lab",
		}),
	);
	const second = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Second lab",
			slug: "second-lab",
		}),
	);
	const project = data(
		await workspace.operations.createProject(owner.headers, {
			organizationId: first.id,
			name: "Private",
			slug: "private",
		}),
	);
	const manager = await workspace.signIn(page, "manager@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: { organizationId: first.id, userId: manager.userId, role: "member" },
	});
	await workspace.auth.api.addMember({
		body: { organizationId: second.id, userId: manager.userId, role: "member" },
	});
	data(
		await workspace.operations.setProjectMember(owner.headers, {
			organizationId: first.id,
			projectId: project.id,
			memberId: membership.id,
			role: "admin",
		}),
	);
	await page.goto(`${workspace.origin}/organizations/${second.id}`);
	await page
		.getByRole("combobox", { name: "Organization", exact: true })
		.selectOption(first.id);
	await page
		.getByRole("button", { name: "Switch organization", exact: true })
		.click();
	await page
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(project.id);
	await page
		.getByRole("button", { name: "Switch project", exact: true })
		.click();
	await page
		.getByRole("link", { name: "Project members", exact: true })
		.click();
	const held = await holdSuccessfulWrite(page);
	await page
		.getByLabel("Project role for manager@example.invalid", { exact: true })
		.selectOption("viewer");
	await page
		.getByRole("button", {
			name: "Save project grant for manager@example.invalid",
			exact: true,
		})
		.click();
	await page
		.getByRole("button", { name: "Confirm access change", exact: true })
		.click();
	await held.ready;
	await page.goBack();
	await expect(page).toHaveURL(
		`${workspace.origin}/organizations/${first.id}/projects/${project.id}/executions`,
	);
	await page.goBack();
	await expect(page).toHaveURL(`${workspace.origin}/organizations/${first.id}`);
	await page.goBack();
	await expect(
		page.getByRole("heading", { name: "Second lab", exact: true }),
	).toBeVisible();
	await held.release();
	await expect(page).toHaveURL(
		`${workspace.origin}/organizations/${second.id}`,
	);
	expect(held.reads).toBe(0);
	expect(
		data(
			await workspace.operations.getProject(manager.headers, {
				organizationId: first.id,
				projectId: project.id,
			}),
		).role,
	).toBe("viewer");
});

test("a delayed organization leave cannot navigate away from another organization", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const first = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "First lab",
			slug: "first-lab",
		}),
	);
	const second = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Second lab",
			slug: "second-lab",
		}),
	);
	const person = await workspace.signIn(page, "member@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: { organizationId: first.id, userId: person.userId, role: "member" },
	});
	await workspace.auth.api.addMember({
		body: { organizationId: second.id, userId: person.userId, role: "member" },
	});
	await page.goto(`${workspace.origin}/organizations/${second.id}`);
	await page
		.getByRole("combobox", { name: "Organization", exact: true })
		.selectOption(first.id);
	await page
		.getByRole("button", { name: "Switch organization", exact: true })
		.click();
	await page.getByRole("link", { name: "Members", exact: true }).click();
	const held = await holdSuccessfulWrite(page);
	await page
		.getByRole("button", {
			name: "Leave organization: member@example.invalid",
			exact: true,
		})
		.click();
	await page
		.getByRole("button", { name: "Confirm leave", exact: true })
		.click();
	await held.ready;
	await page.goBack();
	await expect(page).toHaveURL(`${workspace.origin}/organizations/${first.id}`);
	await expect(
		page.getByRole("heading", { name: "Page not found", exact: true }),
	).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(
		`${workspace.origin}/organizations/${second.id}`,
	);
	await expect(
		page.getByRole("heading", { name: "Second lab", exact: true }),
	).toBeVisible();
	await held.release();
	await expect(page).toHaveURL(
		`${workspace.origin}/organizations/${second.id}`,
	);
	expect(held.reads).toBe(0);
	expect(
		await workspace.database.db
			.select()
			.from(member)
			.where(eq(member.id, membership.id)),
	).toHaveLength(0);
});

test("a delayed invitation acceptance does not redirect after its landing page is left", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Invited lab",
			slug: "invited-lab",
		}),
	);
	const invited = await workspace.auth.api.createInvitation({
		headers: owner.headers,
		body: {
			organizationId: org.id,
			email: "recipient@example.invalid",
			role: "member",
		},
	});
	await workspace.signIn(page, "recipient@example.invalid");
	await page.goto(`${workspace.origin}/invitations/${invited.id}`);
	const held = await holdSuccessfulWrite(page);
	await page
		.getByRole("button", { name: "Accept invitation", exact: true })
		.click();
	await held.ready;
	await page.getByRole("link", { name: "PFE Telemetry", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Your organizations", exact: true }),
	).toBeVisible();
	await held.release();
	await expect(page).toHaveURL(`${workspace.origin}/`);
	expect(held.reads).toBe(0);
	expect(
		(
			await workspace.database.db
				.select()
				.from(invitation)
				.where(eq(invitation.id, invited.id))
		)[0].status,
	).toBe("accepted");
});

test("an old invitation response stays retired after navigating away and back", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const first = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "First lab",
			slug: "first-lab",
		}),
	);
	const second = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Second lab",
			slug: "second-lab",
		}),
	);
	const path = `${workspace.origin}/organizations/${first.id}/members`;
	await page.goto(path);
	const held = await holdSuccessfulWrite(page);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("recipient@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await held.ready;
	await page
		.getByRole("combobox", { name: "Organization", exact: true })
		.selectOption(second.id);
	await page
		.getByRole("button", { name: "Switch organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Second lab", exact: true }),
	).toBeVisible();
	await page
		.getByRole("combobox", { name: "Organization", exact: true })
		.selectOption(first.id);
	await page
		.getByRole("button", { name: "Switch organization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "First lab", exact: true }),
	).toBeVisible();
	await page.getByRole("link", { name: "Members", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: "Resend invitation to recipient@example.invalid",
			exact: true,
		}),
	).toBeVisible();
	await held.release();
	await expect(page).toHaveURL(path);
	expect(held.reads).toBe(0);
	await expect(
		page.getByRole("button", { name: "Dismiss notice", exact: true }),
	).toHaveCount(0);
});

for (const kind of ["invitation", "grant"] as const) {
	test(`retains the successful ${kind} acknowledgement through a GET outage and retries without another POST`, async ({
		page,
		workspace,
	}) => {
		const owner = await workspace.signIn(page, "owner@example.invalid");
		const org = data(
			await workspace.operations.createOrganization(owner.headers, {
				name: "Refresh lab",
				slug: "refresh-lab",
			}),
		);
		const project = data(
			await workspace.operations.createProject(owner.headers, {
				organizationId: org.id,
				name: "Private",
				slug: "private",
			}),
		);
		const target = await workspace.signIn(page, "target@example.invalid");
		await workspace.auth.api.addMember({
			body: { organizationId: org.id, userId: target.userId, role: "member" },
		});
		await workspace.signIn(page, "owner@example.invalid");
		await page.goto(
			`${workspace.origin}/organizations/${org.id}${kind === "grant" ? `/projects/${project.id}/settings` : ""}/members`,
		);
		let writes = 0;
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/_serverFn/"))
				writes++;
		});
		await page.route("**/_serverFn/**", (route) =>
			route.request().method() === "GET" ? route.abort() : route.continue(),
		);
		if (kind === "invitation") {
			await page
				.getByLabel("Email address", { exact: true })
				.fill("new@example.invalid");
			await page
				.getByRole("button", { name: "Send invitation", exact: true })
				.click();
		} else {
			await page
				.getByRole("button", {
					name: "Save project grant for target@example.invalid",
					exact: true,
				})
				.click();
		}
		await expect(
			page.getByRole("heading", { name: "Something went wrong", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("status")).toContainText(
			kind === "invitation"
				? "Your invitation was created, but the list could not refresh."
				: "Your project grant change was saved, but the page could not refresh.",
		);
		expect(writes).toBe(1);
		await page.unroute("**/_serverFn/**");
		await page.getByRole("button", { name: "Try again", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Dismiss notice", exact: true }),
		).toHaveCount(0);
		if (kind === "invitation") {
			await expect(
				page.getByRole("button", {
					name: "Resend invitation to new@example.invalid",
					exact: true,
				}),
			).toBeVisible();
			expect(
				await workspace.database.db
					.select()
					.from(invitation)
					.where(eq(invitation.organizationId, org.id)),
			).toHaveLength(1);
		} else {
			await expect(
				page.getByText("Explicit Viewer", { exact: true }),
			).toBeVisible();
			expect(
				data(
					await workspace.operations.getProject(target.headers, {
						organizationId: org.id,
						projectId: project.id,
					}),
				).role,
			).toBe("viewer");
		}
		expect(writes).toBe(1);
	});
}

for (const transition of ["stay", "navigate", "dismiss-then-navigate"]) {
	const leave = transition !== "stay";
	test(
		transition === "dismiss-then-navigate"
			? "a dismissed membership acknowledgement is not revived after navigation abandons its refresh"
			: leave
				? "navigation during a saved write's pending refresh retires its later error feedback"
				: "a delayed refresh retains the saved acknowledgement through a later error",
		async ({ page, workspace }) => {
			const owner = await workspace.signIn(page, "owner@example.invalid");
			const first = data(
				await workspace.operations.createOrganization(owner.headers, {
					name: "First lab",
					slug: "first-lab",
				}),
			);
			const second = data(
				await workspace.operations.createOrganization(owner.headers, {
					name: "Second lab",
					slug: "second-lab",
				}),
			);
			const target = await workspace.signIn(page, "target@example.invalid");
			await workspace.auth.api.addMember({
				body: {
					organizationId: first.id,
					userId: target.userId,
					role: "member",
				},
			});
			await workspace.signIn(page, "owner@example.invalid");
			await page.goto(`${workspace.origin}/organizations/${first.id}/members`);
			await expect(
				page.getByRole("button", {
					name: "Save role for target@example.invalid",
					exact: true,
				}),
			).toBeEnabled();
			const rpc = await page.evaluate(
				async (modulePath) =>
					(await import(modulePath)).listOrganizationMembers.url as string,
				"/src/organizations/member.functions.ts",
			);
			let started: () => void = () => undefined;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let delivered: () => void = () => undefined;
			const finished = new Promise<void>((resolve) => {
				delivered = resolve;
			});
			let intercepted = false;
			await page.route(
				`${new URL(rpc, workspace.origin).href}*`,
				async (route) => {
					if (intercepted) {
						await route.continue();
						return;
					}
					intercepted = true;
					await route.fetch();
					started();
					await gate;
					await route.abort();
					delivered();
				},
			);
			await page
				.getByLabel("Role for target@example.invalid", { exact: true })
				.selectOption("admin");
			await page
				.getByRole("button", {
					name: "Save role for target@example.invalid",
					exact: true,
				})
				.click();
			await ready;
			if (transition === "dismiss-then-navigate")
				await page
					.getByRole("button", { name: "Dismiss notice", exact: true })
					.click();
			if (leave) {
				await page
					.getByRole("combobox", { name: "Organization", exact: true })
					.selectOption(second.id);
				await page
					.getByRole("button", { name: "Switch organization", exact: true })
					.click();
				await expect(
					page.getByRole("heading", { name: "Second lab", exact: true }),
				).toBeVisible();
				if (transition === "navigate")
					await page
						.getByRole("button", { name: "Dismiss notice", exact: true })
						.click();
			} else {
				await expect(
					page
						.getByRole("status")
						.filter({ hasText: "Your membership change was saved." }),
				).toBeVisible();
				await expect(
					page.getByRole("button", {
						name: "Save role for target@example.invalid",
						exact: true,
					}),
				).toBeDisabled();
			}
			release();
			await finished;
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			if (leave) {
				await expect(page).toHaveURL(
					`${workspace.origin}/organizations/${second.id}`,
				);
				await expect(
					page.getByRole("button", { name: "Dismiss notice", exact: true }),
				).toHaveCount(0);
			} else {
				await expect(
					page.getByRole("heading", {
						name: "Something went wrong",
						exact: true,
					}),
				).toBeVisible();
				await expect(page.getByRole("status")).toContainText(
					"Your membership change was saved, but the page could not refresh.",
				);
			}
			expect(
				data(
					await workspace.operations.getOrganization(target.headers, first.id),
				).role,
			).toBe("admin");
		},
	);
}

test("a saved membership write is acknowledged when its refresh becomes not-found", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Owner lab",
			slug: "owner-lab",
		}),
	);
	const replacement = await workspace.signIn(
		page,
		"replacement@example.invalid",
	);
	await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: replacement.userId, role: "owner" },
	});
	const target = await workspace.signIn(page, "target@example.invalid");
	await workspace.auth.api.addMember({
		body: { organizationId: org.id, userId: target.userId, role: "member" },
	});
	const ownerMember = data(
		await workspace.operations.listOrganizationMembers(owner.headers, org.id),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(`${workspace.origin}/organizations/${org.id}/members`);
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		await workspace.database.db
			.delete(member)
			.where(eq(member.id, ownerMember.id));
		await route.fulfill({ response });
	});
	await page
		.getByLabel("Role for target@example.invalid", { exact: true })
		.selectOption("admin");
	await page
		.getByRole("button", {
			name: "Save role for target@example.invalid",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", { name: "Page not found", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Your membership change was saved, but the page could not refresh.",
	);
	expect(
		data(await workspace.operations.getOrganization(target.headers, org.id))
			.role,
	).toBe("admin");
});

test("fragment navigation retires the old response without leaving retained invitation controls pending", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations.createOrganization(owner.headers, {
			name: "Fragment lab",
			slug: "fragment-lab",
		}),
	);
	const path = `${workspace.origin}/organizations/${org.id}/members`;
	await page.goto(path);
	const held = await holdSuccessfulWrite(page);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("first@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await held.ready;
	await page
		.getByRole("link", { name: "Skip to content", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`${path}#main-content`);
	await expect(
		page.getByRole("button", { name: "Send invitation", exact: true }),
	).toBeEnabled();
	await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
		"first@example.invalid",
	);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("second@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await expect(
		page.getByText("Invitation created.", { exact: false }),
	).toBeVisible();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("third@example.invalid");
	await held.release();
	await expect(page).toHaveURL(`${path}#main-content`);
	await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
		"third@example.invalid",
	);
	await expect(
		page.getByRole("button", { name: "Send invitation", exact: true }),
	).toBeEnabled();
	expect(held.reads).toBe(0);
	expect(
		await workspace.database.db
			.select()
			.from(invitation)
			.where(eq(invitation.organizationId, org.id)),
	).toHaveLength(2);
});

test.describe("composed collector credential lifetime", () => {
	test.skip(
		process.env.PFE_TEST_CREDENTIAL_REVEAL !== "true" &&
			!existsSync(
				new URL(
					"../../src/components/collector-credentials.tsx",
					import.meta.url,
				),
			),
		"Requires the coordinator's composed PFE-56/PFE-57 credential UI and backend",
	);
	test("an abandoned invitation response cannot invalidate a newer one-time token reveal", async ({
		page,
		workspace,
	}) => {
		try {
			const owner = await workspace.signIn(page, "owner@example.invalid");
			const org = data(
				await workspace.operations.createOrganization(owner.headers, {
					name: "Reveal lab",
					slug: "reveal-lab",
				}),
			);
			const project = data(
				await workspace.operations.createProject(owner.headers, {
					organizationId: org.id,
					name: "Private",
					slug: "private",
				}),
			);
			await page.goto(`${workspace.origin}/organizations/${org.id}/members`);
			const held = await holdSuccessfulWrite(page);
			await page
				.getByLabel("Email address", { exact: true })
				.fill("recipient@example.invalid");
			await page
				.getByRole("button", { name: "Send invitation", exact: true })
				.click();
			await held.ready;
			await page
				.getByRole("combobox", { name: "Project", exact: true })
				.selectOption(project.id);
			await page
				.getByRole("button", { name: "Switch project", exact: true })
				.click();
			await page
				.getByRole("link", { name: "Collector credentials", exact: true })
				.click();
			await page
				.getByLabel("Credential name", { exact: true })
				.fill("Reveal source");
			await page.getByLabel("Source ID", { exact: true }).fill("reveal-source");
			await page
				.getByLabel("Allowed host IDs (one per line)", { exact: true })
				.fill("reveal-host");
			await page
				.getByRole("button", { name: "Create credential", exact: true })
				.click();
			const tokenField = page.getByLabel("One-time collector token", {
				exact: true,
			});
			await expect(tokenField).toBeVisible();
			const token = await tokenField.inputValue();
			await page.route("**/_serverFn/**", (route) =>
				route.request().method() === "GET" ? route.abort() : route.fallback(),
			);
			await held.release();
			await expect(page).toHaveURL(
				`${workspace.origin}/organizations/${org.id}/projects/${project.id}/settings/credentials`,
			);
			await expect(tokenField).toBeVisible();
			expect((await tokenField.inputValue()) === token).toBe(true);
			expect(held.reads).toBe(0);
		} finally {
			await page.close();
		}
	});
});
