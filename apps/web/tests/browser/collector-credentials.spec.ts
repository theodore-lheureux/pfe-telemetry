import type { Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import {
	chooseProject,
	closePreferences,
	data,
	expect,
	openPreferences,
	openSettingsSection,
	settingsUrl,
	test,
} from "./fixtures";

let state: {
	origin: string;
	organizationId: string;
	projectId: string;
	otherProjectId: string;
	adminUserId: string;
	ownerCookie: string;
	viewerCookie: string;
	adminCookie: string;
};
test.beforeEach(async ({ page, workspace }) => {
	const owner = await workspace.signIn(page, "collector-owner@example.invalid");
	const viewer = await workspace.signIn(
		page,
		"collector-viewer@example.invalid",
	);
	const administrator = await workspace.signIn(
		page,
		"collector-admin@example.invalid",
	);
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Collector UI",
				slug: "collector-ui",
			}),
		),
	);
	const reference = { organizationId: organization.id };
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				...reference,
				name: "Collector project",
				slug: "collector",
			}),
		),
	);
	const other = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				...reference,
				name: "Other project",
				slug: "other",
			}),
		),
	);
	for (const [person, role] of [
		[viewer, "viewer"],
		[administrator, "admin"],
	] as const) {
		const member = await workspace.auth.api.addMember({
			body: { ...reference, userId: person.userId, role: "member" },
		});
		data(
			await workspace.operations(owner.headers, (actor) =>
				projectDomain.setProjectMember(workspace.database.db, actor, {
					...reference,
					projectId: project.id,
					memberId: member.id,
					role,
				}),
			),
		);
	}
	state = {
		origin: workspace.origin,
		organizationId: organization.id,
		projectId: project.id,
		otherProjectId: other.id,
		adminUserId: administrator.userId,
		ownerCookie: owner.headers.get("cookie") ?? "",
		viewerCookie: viewer.headers.get("cookie") ?? "",
		adminCookie: administrator.headers.get("cookie") ?? "",
	};
});

function path(projectId = state.projectId) {
	return settingsUrl(
		`/organizations/${state.organizationId}/projects/${projectId}`,
		"credentials",
	);
}

async function setSessionCookie(page: Page, cookie: string) {
	await page.context().clearCookies();
	await page.context().addCookies(
		cookie.split("; ").map((part) => {
			const index = part.indexOf("=");
			return {
				name: part.slice(0, index),
				value: part.slice(index + 1),
				url: state.origin,
				httpOnly: true,
			};
		}),
	);
}

async function signIn(page: Page, cookie = state.ownerCookie) {
	await setSessionCookie(page, cookie);
	await page.goto(state.origin + path());
	await expect(
		page.getByRole("heading", { name: "Collector credentials", exact: true }),
	).toBeVisible();
}

async function create(page: Page, name: string) {
	await page.getByLabel("Credential name", { exact: true }).fill(name);
	await page.getByLabel("Source ID", { exact: true }).fill("browser-source");
	await page
		.getByLabel("Enrolled root ID", { exact: true })
		.fill("browser-host");
	await page
		.getByRole("button", { name: "Create credential", exact: true })
		.click();
}

const tokenField = (page: Page) =>
	page.getByLabel("One-time collector token", { exact: true });
const dismiss = (page: Page) =>
	page.getByRole("button", {
		name: "I saved the token — hide it",
		exact: true,
	});

test("create, one-time reveal, clipboard denial, rotation and permanent revocation", async ({
	page,
}) => {
	await signIn(page);
	await create(page, "Lifecycle source");
	await expect(tokenField(page)).toBeVisible();
	const first = await tokenField(page).inputValue();
	expect(/^recount_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(first)).toBe(true);
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeDisabled();
	expect(
		await page.evaluate(
			(token) =>
				JSON.stringify([localStorage, sessionStorage, location.href]).includes(
					token,
				),
			first,
		),
	).toBe(false);
	await page.evaluate(() =>
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async () => {
					throw new DOMException("Denied", "NotAllowedError");
				},
			},
			configurable: true,
		}),
	);
	await page.getByRole("button", { name: "Copy token", exact: true }).click();
	await expect(
		page.getByText("Clipboard access was denied or is unavailable.", {
			exact: false,
		}),
	).toBeVisible();
	await dismiss(page).click();
	await expect(tokenField(page)).toHaveCount(0);
	expect((await page.content()).includes(first)).toBe(false);
	await expect(
		page.getByRole("button", { name: "Rotate Lifecycle source", exact: true }),
	).toBeEnabled();
	await page.reload();
	await expect(tokenField(page)).toHaveCount(0);
	expect((await page.content()).includes(first)).toBe(false);
	await page
		.getByRole("button", { name: "Rotate Lifecycle source", exact: true })
		.click();
	await expect(
		page.getByRole("alertdialog", {
			name: "Confirm rotation of Lifecycle source",
			exact: true,
		}),
	).toContainText("invalidates the old token immediately");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Rotate Lifecycle source", exact: true }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Rotate Lifecycle source", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Confirm rotation", exact: true })
		.click();
	await expect(tokenField(page)).toBeVisible();
	expect((await tokenField(page).inputValue()) !== first).toBe(true);
	await expect(page.locator("#token-reveal-title")).toBeFocused();
	await dismiss(page).click();
	await page
		.getByRole("button", { name: "Revoke Lifecycle source", exact: true })
		.click();
	await expect(
		page.getByRole("alertdialog", {
			name: "Confirm revocation of Lifecycle source",
			exact: true,
		}),
	).toContainText("permanently invalidates");
	await page
		.getByRole("button", { name: "Confirm revocation", exact: true })
		.click();
	await expect(
		page.getByText("Credential revoked.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Rotate Lifecycle source", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Revoke Lifecycle source", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("heading", {
			name: "Manage collector credentials",
			exact: true,
		}),
	).toBeFocused();
});

test("French credential confirmation blocks closing while pending and retains a failed operation", async ({
	page,
}) => {
	await signIn(page);
	await page
		.context()
		.addCookies([{ name: "recount_locale", value: "fr", url: state.origin }]);
	await page.reload();
	const locale = { locale: "fr" } as const;
	await page
		.getByLabel(m.credential_name({}, locale), { exact: true })
		.fill("Source FR");
	await page
		.getByLabel(m.source_id({}, locale), { exact: true })
		.fill("source-fr");
	await page
		.getByLabel(m.enrolled_root_id({}, locale), { exact: true })
		.fill("host-fr");
	await page
		.getByRole("button", { name: m.create_credential({}, locale), exact: true })
		.click();
	await expect(page.locator("#collector-token")).toBeVisible();
	const language = page.getByLabel(m.language({}, locale), { exact: true });
	await expect(language).toHaveCount(0);
	await page
		.getByRole("button", {
			name: m.i_saved_the_token_hide_it({}, locale),
			exact: true,
		})
		.click();
	await openPreferences(page, "fr");
	await expect(language).toBeEnabled();
	await closePreferences(page);
	await page
		.getByRole("button", {
			name: m.rotate_named({ name: "Source FR" }, locale),
			exact: true,
		})
		.click();
	const dialog = page.getByRole("alertdialog");
	await expect(
		dialog.getByText(m.rotation_warning({ name: "Source FR" }, locale), {
			exact: true,
		}),
	).toBeFocused();
	let release = () => {};
	const response = new Promise<void>((resolve) => {
		release = resolve;
	});
	let posts = 0;
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		posts++;
		await response;
		await route.abort("failed");
	});
	try {
		await dialog
			.getByRole("button", {
				name: m.confirm_rotation({}, locale),
				exact: true,
			})
			.click();
		await expect(
			dialog.getByRole("button", { name: m.cancel({}, locale), exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: m.settings({}, locale), exact: true }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		release();
		await expect(dialog.getByRole("alert")).toHaveText(
			m.the_response_was_lost_the_action_may_have({}, locale),
		);
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole("button", {
				name: m.confirm_rotation({}, locale),
				exact: true,
			}),
		).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("heading", {
				name: m.manage_collector_credentials({}, locale),
				exact: true,
			}),
		).toBeFocused();
		await page.unroute("**/_serverFn/**");
		await page
			.getByRole("button", {
				name: m.refresh_credential_list({}, locale),
				exact: true,
			})
			.click();
		await openPreferences(page, "fr");
		await expect(language).toBeEnabled();
		await closePreferences(page);
		expect(posts).toBe(1);
	} finally {
		release();
	}
});

test("a new token survives parent and list outages because revalidation waits for dismissal", async ({
	page,
}) => {
	await signIn(page);
	let revalidations = 0;
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() === "GET") {
			revalidations++;
			await route.abort("failed");
		} else await route.continue();
	});
	await create(page, "Refresh source");
	await expect(tokenField(page)).toBeVisible();
	await expect(
		page.getByText("Credential created. Save the token now.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeDisabled();
	expect(revalidations).toBe(0);
	await page.unroute("**/_serverFn/**");
	await dismiss(page).click();
	await expect(
		page.getByRole("button", { name: "Rotate Refresh source", exact: true }),
	).toBeEnabled();
});

test("viewers cannot list or mutate, while an explicit project admin can manage", async ({
	page,
	browser,
}) => {
	const context = await browser.newContext();
	try {
		const admin = await context.newPage();
		await signIn(admin, state.adminCookie);
		await expect(
			admin.getByRole("button", { name: "Create credential", exact: true }),
		).toBeEnabled();
		const listPath = await identifyListPath(admin, "Access probe");
		let calls = 0;
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === listPath) calls++;
		});
		await signIn(page, state.viewerCookie);
		await expect(
			page.getByText("You have read access.", { exact: false }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Create credential", exact: true }),
		).toHaveCount(0);
		await openSettingsSection(page, "Project settings");
		await page.goBack();
		await expect(
			page.getByText("You have read access.", { exact: false }),
		).toBeVisible();
		await openSettingsSection(admin, "Project settings");
		await expect(
			admin.getByRole("heading", { name: "Settings - General", exact: true }),
		).toBeVisible();
		const credentialsLink = admin.getByRole("link", {
			name: "Collector credentials",
			exact: true,
		});
		await expect(credentialsLink).toHaveAttribute("href", path());
		// Exercise the real retained Link after the browser's session becomes a viewer.
		await setSessionCookie(admin, state.viewerCookie);
		admin.on("request", (request) => {
			if (new URL(request.url()).pathname === listPath) calls++;
		});
		const preloadRequest = admin.waitForRequest(
			(request) =>
				request.method() === "GET" &&
				request.url().includes("/_serverFn/") &&
				new URL(request.url()).pathname !== listPath &&
				request.url().includes(state.projectId),
		);
		await credentialsLink.hover();
		const access = await (await preloadRequest).response();
		if (!access)
			throw new Error(
				"Expected the Link intent preload's project access response",
			);
		expect(access.ok()).toBe(true);
		expect((await access.text()).includes('"viewer"')).toBe(true);
		await expect(admin).toHaveURL(
			settingsUrl(
				`${state.origin}/organizations/${state.organizationId}/projects/${state.projectId}`,
			),
		);
		expect(calls).toBe(0);
		await credentialsLink.click();
		await expect(
			admin.getByText("You have read access.", { exact: false }),
		).toBeVisible();
		expect(calls).toBe(0);
	} finally {
		await context.close();
	}
});

test("project switching and history never restore a dismissed scope's reveal", async ({
	page,
}) => {
	await signIn(page);
	await create(page, "Scope source");
	await expect(tokenField(page)).toBeVisible();
	await chooseProject(page, "Other project");
	await expect(page).toHaveURL(state.origin + path(state.otherProjectId));
	await expect(
		page.getByRole("link", { name: "Collector credentials", exact: true }),
	).toHaveAttribute("href", path(state.otherProjectId));
	await expect(tokenField(page)).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(state.origin + path());
	await expect(
		page.getByRole("button", { name: "Rotate Scope source", exact: true }),
	).toBeEnabled();
	await expect(tokenField(page)).toHaveCount(0);
});

test("late mutation completion cannot reveal into another project and duplicate submission is blocked", async ({
	page,
}) => {
	await signIn(page);
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let posts = 0;
	let completed: (() => void) | undefined;
	const completion = new Promise<void>((resolve) => {
		completed = resolve;
	});
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		posts++;
		const response = await route.fetch();
		await held;
		await route.fulfill({ response }).catch(() => {});
		completed?.();
	});
	try {
		await create(page, "Late source");
		await expect(
			page.getByRole("button", { name: m.creating_credential(), exact: true }),
		).toBeDisabled();
		await chooseProject(page, "Other project");
		await expect(page).toHaveURL(state.origin + path(state.otherProjectId));
		await expect(
			page.getByRole("link", { name: "Collector credentials", exact: true }),
		).toHaveAttribute("href", path(state.otherProjectId));
		await page
			.getByRole("link", { name: "Collector credentials", exact: true })
			.click();
		const response = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("_serverFn"),
		);
		release?.();
		await completion;
		await (await response).finished();
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		await expect(page).toHaveURL(state.origin + path(state.otherProjectId));
		await expect(tokenField(page)).toHaveCount(0);
		expect(posts).toBe(1);
	} finally {
		release?.();
	}
});

test("failed credential listing blocks changes and can be refreshed after saving the token", async ({
	page,
}) => {
	await signIn(page);
	const listPath = await identifyListPath(page, "List probe");
	const matcher = (url: URL) => url.pathname === listPath;
	await page.route(matcher, (route) => route.abort("failed"));
	await create(page, "List outage source");
	await expect(tokenField(page)).toBeVisible();
	await dismiss(page).click();
	await expect(
		page.getByText("Credential list unavailable.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeDisabled();
	await page.unroute(matcher);
	await page
		.getByRole("button", { name: "Refresh credential list", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Rotate List outage source",
			exact: true,
		}),
	).toBeEnabled();
});

test("a mutation denied after permission loss refreshes the owning access context", async ({
	page,
	workspace,
}) => {
	await signIn(page, state.adminCookie);
	const database = workspace.database.pool;
	try {
		await database.query(
			"UPDATE app.project_member SET role = 'viewer' WHERE project_id = $1 AND member_id IN (SELECT id FROM app.member WHERE user_id = $2)",
			[state.projectId, state.adminUserId],
		);
		await create(page, "Denied source");
		await expect(
			page.getByText("You have read access.", { exact: false }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Create credential", exact: true }),
		).toHaveCount(0);
		await expect(tokenField(page)).toHaveCount(0);
	} finally {
		await database.query(
			"UPDATE app.project_member SET role = 'admin' WHERE project_id = $1 AND member_id IN (SELECT id FROM app.member WHERE user_id = $2)",
			[state.projectId, state.adminUserId],
		);
	}
});

test("signout and a different account cannot recover the previous one-time reveal", async ({
	page,
}) => {
	await signIn(page);
	await create(page, "Account source");
	await expect(tokenField(page)).toBeVisible();
	await openSettingsSection(page, "User settings");
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page).toHaveURL(/\/login/);
	await page.context().clearCookies();
	await signIn(page, state.viewerCookie);
	await expect(
		page.getByText("You have read access.", { exact: false }),
	).toBeVisible();
	await expect(tokenField(page)).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(/\/login/);
	await page.goBack();
	await expect(page).toHaveURL(state.origin + path());
	await expect(
		page.getByText("You have read access.", { exact: false }),
	).toBeVisible();
	await expect(tokenField(page)).toHaveCount(0);
});

async function identifyListPath(page: Page, name: string) {
	await create(page, name);
	await expect(tokenField(page)).toBeVisible();
	const responsePromise = page.waitForResponse(
		async (response) =>
			response.request().method() === "GET" &&
			response.url().includes("_serverFn") &&
			(await response.text().catch(() => "")).includes("maximumSubmissionAge"),
	);
	await dismiss(page).click();
	return new URL((await responsePromise).url()).pathname;
}

test("a lost successful mutation response is not automatically retried and can be reconciled", async ({
	page,
}) => {
	await signIn(page);
	let posts = 0;
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		posts++;
		await route.fetch();
		await route.abort("failed");
	});
	await create(page, "Lost response source");
	await expect(
		page.getByText("The response was lost;", { exact: false }),
	).toBeVisible();
	await expect(tokenField(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeDisabled();
	await page.unroute("**/_serverFn/**");
	await page
		.getByRole("button", { name: "Refresh credential list", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Rotate Lost response source",
			exact: true,
		}),
	).toBeEnabled();
	await expect(tokenField(page)).toHaveCount(0);
	expect(posts).toBe(1);
});

test("the client-only enrollment form is disabled before hydration", async ({
	browser,
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	try {
		const page = await context.newPage();
		await signIn(page);
		await expect(
			page.getByLabel("Credential name", { exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Create credential", exact: true }),
		).toBeDisabled();
	} finally {
		await context.close();
	}
});

test("document freezing clears the reveal without fetching, then restoration rechecks access", async ({
	page,
}) => {
	await signIn(page);
	await create(page, "Frozen source");
	await expect(tokenField(page)).toBeVisible();
	let gets = 0;
	await page.route("**/_serverFn/**", (route) => {
		if (route.request().method() === "GET") gets++;
		return route.continue();
	});
	await page.evaluate(() =>
		window.dispatchEvent(
			new PageTransitionEvent("pagehide", { persisted: true }),
		),
	);
	await expect(tokenField(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeDisabled();
	expect(gets).toBe(0);
	await page.evaluate(() =>
		window.dispatchEvent(
			new PageTransitionEvent("pageshow", { persisted: true }),
		),
	);
	await expect(
		page.getByRole("button", { name: "Rotate Frozen source", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Create credential", exact: true }),
	).toBeEnabled();
	expect(gets > 0).toBe(true);
});

test("a pre-freeze mutation response cannot reveal after restoration", async ({
	page,
}) => {
	await signIn(page);
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let complete = () => {};
	const completed = new Promise<void>((resolve) => {
		complete = resolve;
	});
	await page.route("**/_serverFn/**", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		await gate;
		await route.fulfill({ response });
		complete();
	});
	try {
		await create(page, "Pre-freeze source");
		await expect(
			page.getByRole("button", { name: m.creating_credential(), exact: true }),
		).toBeDisabled();
		await page.evaluate(() =>
			window.dispatchEvent(
				new PageTransitionEvent("pagehide", { persisted: true }),
			),
		);
		const response = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("_serverFn"),
		);
		release();
		await completed;
		await (await response).finished();
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		await expect(tokenField(page)).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Create credential", exact: true }),
		).toBeDisabled();
		await page.evaluate(() =>
			window.dispatchEvent(
				new PageTransitionEvent("pageshow", { persisted: true }),
			),
		);
		await expect(
			page.getByRole("button", {
				name: "Rotate Pre-freeze source",
				exact: true,
			}),
		).toBeEnabled();
		await expect(tokenField(page)).toHaveCount(0);
	} finally {
		release();
	}
});

test("cross-document Back does not recover the reveal and observes cache restoration", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() =>
		window.addEventListener("pageshow", (event) => {
			document.documentElement.dataset.cacheRestored = String(event.persisted);
		}),
	);
	await signIn(page);
	await create(page, "Document source");
	await expect(tokenField(page)).toBeVisible();
	await page.goto("about:blank");
	await page.goBack();
	await expect(page).toHaveURL(state.origin + path());
	await expect(
		page.getByRole("heading", { name: "Collector credentials", exact: true }),
	).toBeVisible();
	await expect(tokenField(page)).toHaveCount(0);
	const persisted = await page
		.locator("html")
		.getAttribute("data-cache-restored");
	expect(["true", "false"].includes(persisted ?? "")).toBe(true);
	testInfo.annotations.push({
		type: "pageshow.persisted",
		description: persisted ?? "missing",
	});
});
