import { readFileSync } from "node:fs";
import type { Page, Request } from "@playwright/test";
import { parseAst } from "@tanstack/router-utils";
import { eq } from "drizzle-orm";
import { invitation, member } from "../../src/db/schema";
import * as memberDomain from "../../src/organizations/members.server";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import {
	chooseOrganization,
	chooseProject,
	data,
	expect,
	openSettingsSection,
	settingsUrl,
	test,
} from "./fixtures";

let builtServerFunctionManifest:
	| ReadonlyMap<string, readonly string[]>
	| undefined;

function builtServerFunctionPath(operation: string) {
	if (!builtServerFunctionManifest) {
		// Retain only immutable build metadata, never the AST or request/session data.
		const filename = new URL(
			"../../.output/server/_ssr/ssr.mjs",
			import.meta.url,
		);
		const source = parseAst({
			code: readFileSync(filename, "utf8"),
			filename: filename.pathname,
		});
		const manifest = new Map<string, string[]>();
		for (const statement of source.program.body) {
			if (statement.type !== "VariableDeclaration") continue;
			for (const declaration of statement.declarations) {
				if (declaration.init?.type !== "ObjectExpression") continue;
				for (const entry of declaration.init.properties) {
					if (
						entry.type !== "ObjectProperty" ||
						entry.key.type !== "StringLiteral" ||
						entry.value.type !== "ObjectExpression"
					)
						continue;
					const field = entry.value.properties.find(
						(field) =>
							field.type === "ObjectProperty" &&
							field.key.type === "Identifier" &&
							field.key.name === "functionName" &&
							field.value.type === "StringLiteral",
					);
					if (
						field?.type !== "ObjectProperty" ||
						field.value.type !== "StringLiteral"
					)
						continue;
					const paths = manifest.get(field.value.value) ?? [];
					paths.push(`/_serverFn/${encodeURIComponent(entry.key.value)}`);
					manifest.set(field.value.value, paths);
				}
			}
		}
		builtServerFunctionManifest = manifest;
	}
	const paths =
		builtServerFunctionManifest.get(`${operation}_createServerFn_handler`) ??
		[];
	if (paths.length !== 1)
		throw new Error(
			`Expected one generated server-function manifest entry for ${operation}`,
		);
	return paths[0];
}

async function serverFunctionPath(
	page: Page,
	module: string,
	operation: string,
) {
	if (process.env.RECOUNT_BROWSER_BUILT === "true")
		return builtServerFunctionPath(operation);
	return page.evaluate(
		async ({ module, operation }) =>
			(await import(`/src/organizations/${module}.ts`))[operation]
				.url as string,
		{ module, operation },
	);
}

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
	const pendingReads = new Set<Request>();
	page.on("request", (request) => {
		if (request.method() === "GET" && request.url().includes("/_serverFn/")) {
			pendingReads.add(request);
			if (released) reads++;
		}
	});
	page.on("requestfinished", (request) => pendingReads.delete(request));
	page.on("requestfailed", (request) => pendingReads.delete(request));
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
		async settleNavigationReads() {
			await expect
				.poll(async () => {
					if (pendingReads.size) return false;
					await page.evaluate(
						() =>
							new Promise<void>((resolve) =>
								requestAnimationFrame(() =>
									requestAnimationFrame(() => resolve()),
								),
							),
					);
					return pendingReads.size === 0;
				})
				.toBe(true);
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
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Expiry lab",
					slug: "expiry-lab",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: org.id,
					name: "Private",
					slug: "private",
				}),
			),
		);
		const parent = child.project
			? settingsUrl(`/organizations/${org.id}/projects/${project.id}`)
			: settingsUrl(`/organizations/${org.id}`, "organization");
		const destination = settingsUrl(
			`/organizations/${org.id}${child.project ? `/projects/${project.id}` : ""}`,
			child.project ? "project-members" : "organization-members",
		);
		await page.goto(`${workspace.origin}${parent}`);
		await expect(
			page.getByRole("button", {
				name: "Switch project, organization or account",
				exact: true,
			}),
		).toBeEnabled({ timeout: 20_000 });
		const rpc = await serverFunctionPath(page, child.module, child.operation);
		const rpcMatcher = `${new URL(rpc, workspace.origin).href}*`;
		let expired = false;
		await page.route(rpcMatcher, async (route) => {
			// Keep this child fault armed through both intent preload and navigation.
			expired = true;
			const response = await route.fetch({
				headers: { ...route.request().headers(), cookie: "" },
			});
			expect((await response.text()).includes("UNAUTHENTICATED")).toBe(true);
			await route.fulfill({ response });
		});
		await page
			.getByRole("link", {
				name: child.project ? "Project members" : "Members",
				exact: true,
			})
			// Target navigation rather than a hover-triggered speculative read.
			.dispatchEvent("click", { button: 0 });
		await expect(page).toHaveURL(/\/login\?redirect=/);
		expect(expired).toBe(true);
		expect(new URL(page.url()).searchParams.get("redirect")).toBe(destination);
		await page.unroute(rpcMatcher);
		await workspace.enableCodeDelivery(page);
		await page
			.getByLabel("Email address", { exact: true })
			.fill("owner@example.invalid");
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await workspace.submitReceivedCode(page, "owner@example.invalid");
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
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "First lab",
				slug: "first-lab",
			}),
		),
	);
	const second = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Second lab",
				slug: "second-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: first.id,
				name: "Private",
				slug: "private",
			}),
		),
	);
	const manager = await workspace.signIn(page, "manager@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: { organizationId: first.id, userId: manager.userId, role: "member" },
	});
	await workspace.auth.api.addMember({
		body: { organizationId: second.id, userId: manager.userId, role: "member" },
	});
	data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.setProjectMember(workspace.database.db, actor, {
				organizationId: first.id,
				projectId: project.id,
				memberId: membership.id,
				role: "admin",
			}),
		),
	);
	await page.goto(`${workspace.origin}/organizations/${second.id}`);
	await chooseOrganization(page, first.name);
	await chooseProject(page, project.name);
	await openSettingsSection(page, "Project members");
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
			await workspace.operations(manager.headers, (actor) =>
				projectDomain.getProject(workspace.database.db, actor, {
					organizationId: first.id,
					projectId: project.id,
				}),
			),
		).role,
	).toBe("viewer");
});

test("a delayed organization leave cannot navigate away from another organization", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const first = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "First lab",
				slug: "first-lab",
			}),
		),
	);
	const second = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Second lab",
				slug: "second-lab",
			}),
		),
	);
	const person = await workspace.signIn(page, "member@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: { organizationId: first.id, userId: person.userId, role: "member" },
	});
	await workspace.auth.api.addMember({
		body: { organizationId: second.id, userId: person.userId, role: "member" },
	});
	await page.goto(`${workspace.origin}/organizations/${second.id}`);
	await chooseOrganization(page, first.name);
	await expect(
		page.getByRole("heading", { name: "First lab", exact: true }),
	).toBeVisible();
	await openSettingsSection(page, "Members");
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
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Invited lab",
				slug: "invited-lab",
			}),
		),
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
	// A stationary pointer can intent-preload a new home-page link under it.
	await page.mouse.move(0, 0);
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Your organizations", exact: true }),
	).toBeVisible();
	await held.settleNavigationReads();
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
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "First lab",
				slug: "first-lab",
			}),
		),
	);
	const second = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Second lab",
				slug: "second-lab",
			}),
		),
	);
	const path = settingsUrl(
		`${workspace.origin}/organizations/${first.id}`,
		"organization-members",
	);
	await page.goto(path);
	const held = await holdSuccessfulWrite(page);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("recipient@example.invalid");
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await held.ready;
	await chooseOrganization(page, second.name);
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toContainText(second.name);
	await chooseOrganization(page, first.name);
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toContainText(first.name);
	await openSettingsSection(page, "Members");
	await expect(
		page.getByRole("button", {
			name: "Resend invitation to recipient@example.invalid",
			exact: true,
		}),
	).toBeVisible();
	await page.mouse.move(0, 0);
	await held.settleNavigationReads();
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
					organizationId: org.id,
					name: "Private",
					slug: "private",
				}),
			),
		);
		const target = await workspace.signIn(page, "target@example.invalid");
		await workspace.auth.api.addMember({
			body: { organizationId: org.id, userId: target.userId, role: "member" },
		});
		await workspace.signIn(page, "owner@example.invalid");
		await page.goto(
			settingsUrl(
				`${workspace.origin}/organizations/${org.id}${kind === "grant" ? `/projects/${project.id}` : ""}`,
				kind === "grant" ? "project-members" : "organization-members",
			),
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
					await workspace.operations(target.headers, (actor) =>
						projectDomain.getProject(workspace.database.db, actor, {
							organizationId: org.id,
							projectId: project.id,
						}),
					),
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
				await workspace.operations(owner.headers, () =>
					organizationDomain.createOrganization(workspace.auth, owner.headers, {
						name: "First lab",
						slug: "first-lab",
					}),
				),
			);
			const second = data(
				await workspace.operations(owner.headers, () =>
					organizationDomain.createOrganization(workspace.auth, owner.headers, {
						name: "Second lab",
						slug: "second-lab",
					}),
				),
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
			await page.goto(
				settingsUrl(
					`${workspace.origin}/organizations/${first.id}`,
					"organization-members",
				),
			);
			await expect(
				page.getByRole("button", {
					name: "Save role for target@example.invalid",
					exact: true,
				}),
			).toBeEnabled();
			const rpc = await serverFunctionPath(
				page,
				"member.functions",
				"listOrganizationMembers",
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
				await chooseOrganization(page, second.name);
				await expect(
					page.getByRole("button", {
						name: "Switch project, organization or account",
						exact: true,
					}),
				).toContainText(second.name);
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
					page
						.getByLabel("Role for target@example.invalid", { exact: true })
						.locator("xpath=ancestor::form")
						.locator('button[type="submit"]'),
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
					await workspace.operations(target.headers, (actor) =>
						organizationDomain.getOrganization(
							workspace.database.db,
							actor,
							first.id,
						),
					),
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
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Owner lab",
				slug: "owner-lab",
			}),
		),
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
		await workspace.operations(owner.headers, (actor) =>
			memberDomain.listMembers(
				workspace.database.db,
				workspace.auth,
				owner.headers,
				actor,
				org.id,
			),
		),
	).find((entry) => entry.userId === owner.userId);
	if (!ownerMember) throw new Error("Expected canonical owner");
	await workspace.signIn(page, "owner@example.invalid");
	await page.goto(
		settingsUrl(
			`${workspace.origin}/organizations/${org.id}`,
			"organization-members",
		),
	);
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
		data(
			await workspace.operations(target.headers, (actor) =>
				organizationDomain.getOrganization(
					workspace.database.db,
					actor,
					org.id,
				),
			),
		).role,
	).toBe("admin");
});

test("fragment navigation retires the old response without leaving retained invitation controls pending", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Fragment lab",
				slug: "fragment-lab",
			}),
		),
	);
	const path = settingsUrl(
		`${workspace.origin}/organizations/${org.id}`,
		"organization-members",
	);
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
	test("an abandoned invitation response cannot invalidate a newer one-time token reveal", async ({
		page,
		workspace,
	}) => {
		try {
			const owner = await workspace.signIn(page, "owner@example.invalid");
			const org = data(
				await workspace.operations(owner.headers, () =>
					organizationDomain.createOrganization(workspace.auth, owner.headers, {
						name: "Reveal lab",
						slug: "reveal-lab",
					}),
				),
			);
			const project = data(
				await workspace.operations(owner.headers, (actor) =>
					projectDomain.createProject(workspace.database.db, actor, {
						requestId: crypto.randomUUID(),
						organizationId: org.id,
						name: "Private",
						slug: "private",
					}),
				),
			);
			await page.goto(
				settingsUrl(
					`${workspace.origin}/organizations/${org.id}`,
					"organization-members",
				),
			);
			const held = await holdSuccessfulWrite(page);
			await page
				.getByLabel("Email address", { exact: true })
				.fill("recipient@example.invalid");
			await page
				.getByRole("button", { name: "Send invitation", exact: true })
				.click();
			await held.ready;
			await chooseProject(page, project.name);
			await openSettingsSection(page, "Collector credentials");
			await page
				.getByLabel("Credential name", { exact: true })
				.fill("Reveal source");
			await page.getByLabel("Source ID", { exact: true }).fill("reveal-source");
			await page
				.getByLabel("Enrolled root ID", { exact: true })
				.fill("reveal-host");
			await page
				.getByRole("button", { name: "Create credential", exact: true })
				.click();
			const tokenField = page.getByLabel("One-time collector token", {
				exact: true,
			});
			await expect(tokenField).toBeVisible();
			const grants = await workspace.database.pool.query(
				`SELECT g.resource_id,g.resource_kind,g.adapter,g.allowed_local_kinds
           FROM ingestion.collector_root_grant g JOIN ingestion.collector_credential c
           ON (g.credential_id,g.project_id,g.organization_id)=(c.id,c.project_id,c.organization_id)
           WHERE c.organization_id=$1 AND c.project_id=$2 AND c.source_id=$3`,
				[org.id, project.id, "reveal-source"],
			);
			expect(grants.rows).toEqual([
				{
					resource_id: "reveal-host",
					resource_kind: 1,
					adapter: "linux",
					allowed_local_kinds: [4],
				},
			]);
			const token = await tokenField.inputValue();
			await page.route("**/_serverFn/**", (route) =>
				route.request().method() === "GET" ? route.abort() : route.fallback(),
			);
			await held.release();
			await expect(page).toHaveURL(
				settingsUrl(
					`${workspace.origin}/organizations/${org.id}/projects/${project.id}`,
					"credentials",
				),
			);
			await expect(tokenField).toBeVisible();
			expect((await tokenField.inputValue()) === token).toBe(true);
			expect(held.reads).toBe(0);
		} finally {
			await page.close();
		}
	});
});
