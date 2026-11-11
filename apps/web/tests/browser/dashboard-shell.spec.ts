import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { m } from "@recount/i18n/messages";
import { eq } from "drizzle-orm";
import {
	organization as orgTable,
	passkey as passkeyTable,
	session as sessionTable,
	user as userTable,
} from "../../src/db/schema";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import { gate as createGate } from "../gate";
import { settingsPath } from "../settings-path";
import {
	chooseProject,
	chooseTheme,
	data,
	expect,
	openWorkspaceMenu,
	test,
} from "./fixtures";

test("settings search opens individual controls and closed timing details within the selected project", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "settings-search@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Search fixture",
				slug: "search-fixture",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Search project",
			}),
		),
	);
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto(
		`${workspace.origin}${settingsPath("user", { organizationId: organization.id, projectId: project.id })}`,
	);
	const nav = page.getByRole("navigation", {
		name: "Settings navigation",
		exact: true,
	});
	await expect(
		nav.getByRole("link", { name: "Project settings", exact: true }),
	).toHaveCSS("height", "28px");
	const search = nav.getByRole("combobox", {
		name: "Search settings",
		exact: true,
	});
	await expect(search).toBeEnabled();
	await search.fill("enrollment");
	await expect(
		nav.getByRole("option", {
			name: "Enrollment keys",
			exact: true,
		}),
	).toBeVisible();
	const searchArtifacts = process.env.RECOUNT_ARTIFACT_DIR;
	if (searchArtifacts) {
		await mkdir(searchArtifacts, { recursive: true });
		await page.screenshot({
			path: join(searchArtifacts, "individual-settings-search.png"),
			fullPage: true,
		});
	}
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(page.locator("#enrollment-keys")).toBeVisible();
	expect(new URL(page.url()).searchParams.get("projectId")).toBe(project.id);
	expect(new URL(page.url()).hash).toBe("#enrollment-keys");
	await search.fill("email address");
	await nav.getByRole("option", { name: "Email address", exact: true }).click();
	await expect(page.locator("#profile-email")).toBeDisabled();
	expect(new URL(page.url()).searchParams.get("organizationId")).toBe(
		organization.id,
	);
	expect(new URL(page.url()).hash).toBe("#profile-email");
});

test("profile name, Gravatar refresh, passkey rename and session revocation use current identity", async ({
	page,
	browser,
	workspace,
}) => {
	const email = "profile-controls@example.invalid";
	await page.setViewportSize({ width: 1440, height: 960 });
	const owner = await workspace.signIn(page, email);
	const context = await browser.newContext();
	try {
		const other = await workspace.signIn(await context.newPage(), email);
		await workspace.database.db.insert(passkeyTable).values({
			id: "profile-fixture-key",
			name: "Original key",
			userId: owner.userId,
			publicKey: "unused-for-profile-controls",
			credentialID: "profile-fixture-credential",
			counter: 0,
			deviceType: "singleDevice",
			backedUp: false,
		});
		const avatars: string[] = [];
		page.on("request", (request) => {
			if (request.url().startsWith("https://gravatar.com/avatar/"))
				avatars.push(request.url());
		});
		await page.goto(`${workspace.origin}/settings?section=user`);
		await expect(
			page.getByRole("heading", { name: "Profile", exact: true }),
		).toBeVisible();
		await expect
			.poll(() =>
				avatars.some((url) => new URL(url).searchParams.get("s") === "256"),
			)
			.toBe(true);
		await expect(
			page.getByLabel("Email address", { exact: true }),
		).toHaveJSProperty("readOnly", true);
		await expect(
			page.getByLabel("Email address", { exact: true }),
		).toBeDisabled();
		await expect(
			page
				.getByRole("region", { name: "Details", exact: true })
				.locator('[data-slot="card"]'),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Save name", exact: true }),
		).toBeDisabled();
		await page.getByLabel("Name", { exact: true }).fill("Updated Owner");
		await page.getByRole("button", { name: "Save name", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Save name", exact: true }),
		).toBeDisabled();
		await openWorkspaceMenu(page);
		await expect(
			page.getByRole("menuitem", { name: "User settings", exact: true }),
		).toContainText("Updated Owner");
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Check again", exact: true })
			.click();
		await expect
			.poll(() => avatars.some((url) => url.includes("recount_refresh=")))
			.toBe(true);
		expect(avatars.every((url) => !url.includes(email))).toBe(true);
		const directory = process.env.RECOUNT_ARTIFACT_DIR;
		if (directory) {
			await mkdir(directory, { recursive: true });
			await page.screenshot({
				path: join(directory, "profile-en-light.png"),
				fullPage: true,
			});
		}
		await page.getByRole("button", { name: "Rename", exact: true }).click();
		const rename = page.getByRole("dialog", {
			name: "Rename passkey",
			exact: true,
		});
		await rename
			.getByLabel("Passkey name", { exact: true })
			.fill("Renamed key");
		await rename.getByRole("button", { name: "Save", exact: true }).click();
		await expect(rename).toBeHidden();
		await expect(
			page.getByRole("cell", { name: "Renamed key", exact: true }),
		).toBeVisible();
		const sessions = page.getByRole("region", {
			name: "Web sessions",
			exact: true,
		});
		await expect(
			sessions.getByText("This device", { exact: true }),
		).toHaveCount(1);
		const rowHeights = await sessions
			.locator("tbody tr")
			.evaluateAll((rows) =>
				rows.map((row) => row.getBoundingClientRect().height),
			);
		expect(rowHeights).toHaveLength(2);
		expect(new Set(rowHeights).size).toBe(1);
		await sessions
			.getByRole("button", { name: "Log out of this device", exact: true })
			.click();
		await expect(
			sessions.getByRole("button", {
				name: "Log out of this device",
				exact: true,
			}),
		).toHaveCount(0);
		expect(
			await workspace.auth.api.getSession({ headers: other.headers }),
		).toBeNull();
		expect(
			(await workspace.auth.api.getSession({ headers: owner.headers }))?.user
				.name,
		).toBe("Updated Owner");
		await workspace.database.db
			.update(sessionTable)
			.set({ createdAt: new Date(Date.now() - 601_000) })
			.where(eq(sessionTable.userId, owner.userId));
		await page.reload();
		await expect(
			sessions.getByRole("link", { name: "Sign in again", exact: true }),
		).toHaveCount(0);
		await expect(sessions.getByRole("table")).toBeVisible();
		await expect(
			sessions.getByRole("button", { name: "Try again", exact: true }),
		).toHaveCount(0);
	} finally {
		await context.close();
	}
});

for (const locale of ["en", "fr"] as const) {
	test(`project shell and unified scoped settings in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const owner = await workspace.signIn(page, "posthog-owner@example.invalid");
		await workspace.database.db
			.update(userTable)
			.set({
				name: "Fixture Owner",
				image: "https://avatars.example.invalid/user.png",
			})
			.where(eq(userTable.id, owner.userId));
		const organization = data(
			await workspace.operations(owner.headers, () =>
				organizationDomain.createOrganization(workspace.auth, owner.headers, {
					name: "Fixture Research",
					slug: "fixture-research",
				}),
			),
		);
		await workspace.database.db
			.update(orgTable)
			.set({ logo: "https://avatars.example.invalid/org.svg" })
			.where(eq(orgTable.id, organization.id));
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Collector trial",
				}),
			),
		);
		const second = data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.createProject(workspace.database.db, actor, {
					requestId: crypto.randomUUID(),
					organizationId: organization.id,
					name: "Comparison trial",
				}),
			),
		);
		const avatarRequests: { url: string; referer?: string }[] = [];
		await page.route("https://avatars.example.invalid/org.svg", (route) =>
			route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="4" fill="#0f766e"/></svg>',
			}),
		);
		page.on("request", (request) => {
			if (
				/^https:\/\/(gravatar.com|avatars.example.invalid)\//.test(
					request.url(),
				)
			)
				avatarRequests.push({
					url: request.url(),
					referer: request.headers().referer,
				});
		});
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (/hydration|did not match|Minified React error/i.test(message.text()))
				errors.push(message.text());
		});
		const mobile = locale === "fr";
		await page.setViewportSize({ width: mobile ? 375 : 1440, height: 960 });
		await page.context().addCookies([
			{ name: "recount_locale", value: locale, url: workspace.origin },
			{
				name: "recount_theme",
				value: mobile ? "tide-dark" : "tide",
				url: workspace.origin,
			},
		]);
		const initialResponse = await page.goto(
			`${workspace.origin}/organizations/${organization.id}/projects/${project.id}/executions`,
		);
		expect(await initialResponse?.text()).toContain(
			'data-slot="sidebar-wrapper"',
		);
		const refreshedResponse = await page.reload();
		expect(await refreshedResponse?.text()).toContain(
			'data-slot="sidebar-wrapper"',
		);
		const switcher = page.getByRole("button", {
			name: m.switch_workspace({}, options),
			exact: true,
		});
		const mobileTrigger = page.getByRole("button", {
			name: m.open_navigation({}, options),
			exact: true,
		});
		const divider = page.getByRole("separator", {
			name: m.project_navigation({}, options),
			exact: true,
		});
		async function resizeSidebar(targetX: number) {
			const bounds = await divider.boundingBox();
			if (!bounds) throw new Error("Expected the navigation resize divider");
			const y = bounds.y + 200;
			await page.mouse.move(bounds.x + bounds.width / 2, y);
			await page.mouse.down();
			await page.mouse.move(targetX, y, { steps: 8 });
			await page.mouse.up();
		}
		await expect(mobile ? mobileTrigger : switcher).toBeEnabled();
		async function expectSelection(name: string) {
			if (mobile) await mobileTrigger.click();
			await expect(switcher).toContainText(name);
			if (mobile) {
				await page.keyboard.press("Escape");
				await expect(
					page.getByRole("dialog", {
						name: m.navigation({}, options),
						exact: true,
					}),
				).toBeHidden();
			}
		}
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			mobile ? "tide-dark" : "tide",
		);
		await expectSelection(project.name);
		await expect(page.getByRole("main")).toHaveCount(1);
		await expect(page.locator("[data-public-header], footer")).toHaveCount(0);
		await expect(
			page.locator("header").getByRole("img", { name: "Recount", exact: true }),
		).toHaveCount(0);
		await expect(page.locator("[data-app-toolbar]")).toHaveCount(0);
		const organizationImage = page.locator(
			'[data-slot="sidebar-header"] [data-identity="organization"] img',
		);
		async function expectOrganizationIcon() {
			await expect(organizationImage).toHaveAttribute(
				"src",
				"https://avatars.example.invalid/org.svg",
			);
			await expect(organizationImage).toHaveCSS("object-fit", "cover");
			await expect(organizationImage.locator("..")).toHaveCSS("width", "20px");
			await expect(organizationImage.locator("..")).toHaveCSS("height", "20px");
			await expect(organizationImage.locator("..")).toHaveCSS(
				"overflow",
				"hidden",
			);
		}
		async function expectProjectLinks(root: ReturnType<typeof page.locator>) {
			await expect(root.getByRole("link")).toHaveCount(3);
			await expect(
				root.getByRole("link", {
					name: m.activity_title({}, options),
					exact: true,
				}),
			).toHaveAttribute(
				"href",
				`/organizations/${organization.id}/projects/${project.id}/activity`,
			);
			await expect(
				root.getByRole("link", {
					name: m.executions({}, options),
					exact: true,
				}),
			).toHaveAttribute(
				"href",
				`/organizations/${organization.id}/projects/${project.id}/executions`,
			);
			await expect(
				root.getByRole("link", { name: m.settings({}, options), exact: true }),
			).toHaveAttribute(
				"href",
				settingsPath("project", {
					organizationId: organization.id,
					projectId: project.id,
				}),
			);
		}
		if (mobile) {
			const trigger = page.getByRole("button", {
				name: m.open_navigation({}, options),
				exact: true,
			});
			await trigger.focus();
			await page.keyboard.press("Enter");
			const drawer = page.getByRole("dialog", {
				name: m.navigation({}, options),
				exact: true,
			});
			await expect(drawer).toBeVisible();
			await expectOrganizationIcon();
			await expectProjectLinks(drawer);
			for (let index = 0; index < 5; index++) {
				await page.keyboard.press("Tab");
				expect(
					await drawer.evaluate((element) =>
						element.contains(document.activeElement),
					),
				).toBe(true);
			}
			await page.keyboard.press("Escape");
			await expect(trigger).toBeFocused();
		} else {
			await expectOrganizationIcon();
			const bounds = await page
				.locator('[data-slot="sidebar-container"]')
				.boundingBox();
			expect(bounds?.y).toBe(0);
			expect(bounds?.height).toBe(960);
			expect(bounds?.width).toBe(200);
			const sidebar = page.locator('[data-slot="sidebar"][data-state]');
			await expect(sidebar).toHaveAttribute("data-state", "expanded");
			await expectProjectLinks(page.locator('[data-slot="sidebar-container"]'));
			await expect(
				page.getByRole("button", {
					name: m.toggle_navigation({}, options),
					exact: true,
				}),
			).toHaveCount(0);
			await resizeSidebar(300);
			expect(
				await page
					.locator('[data-slot="sidebar-container"]')
					.evaluate((element) => element.getBoundingClientRect().width),
			).toBeGreaterThan(270);
			await resizeSidebar(60);
			await expect(sidebar).toHaveAttribute("data-collapsible", "icon");
			await expect(switcher).toBeVisible();
			await expect(switcher).toHaveCSS("width", "32px");
			await openWorkspaceMenu(page, locale);
			await expect(page.getByRole("menu")).toBeVisible();
			await page.keyboard.press("Escape");
			await page.keyboard.press("ControlOrMeta+b");
			await expect(sidebar).toHaveAttribute("data-state", "expanded");
			await resizeSidebar(200);
		}
		await chooseProject(page, second.name, locale);
		await expectSelection(second.name);
		await chooseProject(page, project.name, locale);
		await openWorkspaceMenu(page, locale);
		await page
			.getByRole("menuitem", {
				name: m.user_settings({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: m.user_profile({}, options),
				exact: true,
			}),
		).toBeVisible();
		expect(new URL(page.url()).searchParams.get("organizationId")).toBe(
			organization.id,
		);
		expect(new URL(page.url()).searchParams.get("projectId")).toBe(project.id);
		await expectSelection(project.name);
		const nav = page.getByRole("navigation", {
			name: m.settings_navigation({}, options),
			exact: true,
		});
		if (mobile) {
			expect(
				await page
					.getByRole("heading", {
						name: m.user_profile({}, options),
						exact: true,
					})
					.evaluate((element) => element.getBoundingClientRect().top),
			).toBeLessThan(300);
			await nav
				.getByRole("button", {
					name: `${m.settings({}, options)} · ${m.user_profile({}, options)}`,
					exact: true,
				})
				.click();
		}
		await nav
			.getByRole("button", { name: m.project({}, options), exact: true })
			.click();
		await expect(
			nav.getByRole("link", {
				name: m.project_settings({}, options),
				exact: true,
			}),
		).not.toBeVisible();
		await nav
			.getByRole("button", { name: m.project({}, options), exact: true })
			.click();
		const passkeyName = page.getByLabel(m.passkey_name({}, options), {
			exact: true,
		});
		await passkeyName.fill("Unsaved fixture key");
		if (!mobile) {
			await resizeSidebar(60);
			await expect(passkeyName).toHaveValue("Unsaved fixture key");
			await resizeSidebar(200);
			await expect(passkeyName).toHaveValue("Unsaved fixture key");
		}
		await nav
			.getByLabel(m.search_settings({}, options), { exact: true })
			.fill(m.appearance({}, options));
		await expect(
			nav.getByRole("link", {
				name: m.project_settings({}, options),
				exact: true,
			}),
		).toHaveCount(0);
		await nav
			.getByLabel(m.search_settings({}, options), { exact: true })
			.fill("");
		await expect(passkeyName).toHaveValue("Unsaved fixture key");
		await openWorkspaceMenu(page, locale);
		for (const mark of await page
			.locator(
				'[data-slot="dropdown-menu-content"] [data-identity="organization"], [data-slot="dropdown-menu-content"] [data-identity="project"]',
			)
			.all()) {
			await expect(mark).toHaveCSS("width", "16px");
			await expect(mark).toHaveCSS("height", "16px");
			await expect(mark).toHaveCSS("overflow", "hidden");
		}
		await expect(
			page.locator(
				'[data-slot="dropdown-menu-content"] [data-identity="user"] [data-slot="avatar-fallback"]',
			),
		).toHaveText("FO");
		await expect
			.poll(() =>
				avatarRequests.some(({ url }) =>
					/^https:\/\/gravatar.com\/avatar\/[a-f0-9]{64}\?d=404&s=64$/.test(
						url,
					),
				),
			)
			.toBe(true);
		for (const request of avatarRequests) {
			expect(request.referer).toBeUndefined();
			expect(request.url).not.toContain("posthog-owner");
		}
		const directory = process.env.RECOUNT_ARTIFACT_DIR;
		if (directory) await mkdir(directory, { recursive: true });
		if (directory && !mobile) {
			await expect(
				page.locator('[data-slot="dropdown-menu-content"]'),
			).toHaveCSS("opacity", "1");
			await page.screenshot({
				path: join(directory, "desktop-en-light.png"),
				fullPage: true,
			});
		}
		await page.keyboard.press("Escape");
		await expect(switcher).toBeFocused();
		if (mobile) {
			await page.keyboard.press("Escape");
			await expect(mobileTrigger).toBeFocused();
		}
		await nav
			.getByRole("link", {
				name: m.appearance_language({}, options),
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: m.appearance_language({}, options),
				exact: true,
				level: 1,
			}),
		).toBeVisible();
		const language = page.getByLabel(m.language({}, options), { exact: true });
		await chooseTheme(page, mobile ? "light" : "dark", locale);
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			mobile ? "tide" : "tide-dark",
		);
		await chooseTheme(page, mobile ? "dark" : "light", locale);
		await language.selectOption(locale === "en" ? "fr" : "en");
		await expect(
			page.getByRole("button", { name: m.cancel({}, options), exact: true }),
		).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(language).toBeFocused();
		await expect(page.locator("html")).toHaveAttribute("lang", locale);
		expect(new URL(page.url()).searchParams.get("projectId")).toBe(project.id);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		if (directory && mobile)
			await page.screenshot({
				path: join(directory, "mobile-fr-dark.png"),
				fullPage: true,
			});
		await page.goBack();
		await expect(passkeyName).toHaveValue("");
		await nav
			.getByRole("link", { name: m.collectors({}, options), exact: true })
			.click();
		let writes = 0;
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/_serverFn/"))
				writes++;
		});
		await page
			.getByRole("button", {
				name: m.enrollment_key_create({}, options),
				exact: true,
			})
			.click();
		const create = page.getByRole("dialog", {
			name: m.enrollment_key_create({}, options),
		});
		await create
			.getByLabel(m.name({}, options), { exact: true })
			.fill("Fixture key");
		await create
			.getByRole("button", {
				name: m.enrollment_key_create({}, options),
				exact: true,
			})
			.click();
		const keyField = page
			.getByRole("dialog", {
				name: m.enrollment_key_created_title({}, options),
			})
			.locator("code")
			.first()
			.first();
		await expect(keyField).toBeVisible();
		const secret = (await keyField.textContent()) ?? "";
		await page.keyboard.press("Escape");
		await nav
			.getByRole("link", {
				name: m.appearance_language({}, options),
				exact: true,
			})
			.click();
		await expect(language).toBeEnabled();
		await page.goBack();
		await expect(
			page.getByRole("heading", {
				name: m.collectors({}, options),
				exact: true,
			}),
		).toBeVisible();
		await expect(keyField).toHaveCount(0);
		expect((await page.content()).includes(secret)).toBe(false);
		expect(writes).toBe(1);
		expect(errors).toEqual([]);
	});
}

test("own user settings stay available to a project viewer, with tenant-qualified read context", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "scope-owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Read scope",
				slug: "read-scope",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Viewer project",
			}),
		),
	);
	const viewer = await workspace.signIn(page, "scope-viewer@example.invalid");
	const membership = await workspace.auth.api.addMember({
		body: {
			organizationId: organization.id,
			userId: viewer.userId,
			role: "member",
		},
	});
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
	const selected = { organizationId: organization.id, projectId: project.id };
	const response = await page.goto(
		workspace.origin + settingsPath("user", selected),
	);
	expect(response?.status()).toBe(200);
	expect(response?.headers()["cache-control"]).toContain("no-store");
	await expect(
		page.getByRole("heading", { name: "Profile", exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "Settings navigation" })
			.getByRole("link", { name: "Access control", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("navigation", { name: "Settings navigation" })
		.getByRole("link", { name: "Appearance and language", exact: true })
		.click();
	const { promise: gate, release } = createGate();
	const { promise: received, release: entered } = createGate();
	let signouts = 0;
	await page.route("**/api/auth/sign-out", async (route) => {
		signouts++;
		entered();
		await gate;
		await route.fulfill({
			status: 400,
			json: { message: "Fixture rejected signout" },
		});
	});
	try {
		await openWorkspaceMenu(page);
		await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
		await received;
		await expect(page.getByLabel("Language", { exact: true })).toBeDisabled();
	} finally {
		release();
	}
	await expect(page.getByRole("alert")).toContainText(
		m.signout_failed_please_try_again({}, { locale: "en" }),
	);
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("Language", { exact: true })).toBeEnabled();
	expect(signouts).toBe(1);
	expect(new URL(page.url()).searchParams.get("projectId")).toBe(project.id);
	await page.unroute("**/api/auth/sign-out");
	await page.goto(workspace.origin + settingsPath("collectors", selected));
	await expect(
		page.getByRole("heading", { name: "Page not found", exact: true }),
	).toBeVisible();
	await page.goto(workspace.origin + settingsPath("project-members", selected));
	await expect(
		page.getByRole("heading", { name: "Something went wrong", exact: true }),
	).toBeVisible();
	expect((await page.content()).includes("scope-owner@example.invalid")).toBe(
		false,
	);
	const denied = await page.goto(
		workspace.origin +
			settingsPath("user", {
				organizationId: "another-organization",
				projectId: project.id,
			}),
	);
	expect(denied?.status()).toBe(404);
	await workspace.signIn(page, "new-account@example.invalid");
	await page.goto(workspace.origin + settingsPath("user"));
	await expect(
		page.getByRole("heading", { name: "Profile", exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "Settings navigation" })
			.getByRole("button", { name: "Project", exact: true }),
	).toHaveCount(0);
});
