import { m } from "@recount/i18n/messages";
import { eq } from "drizzle-orm";
import { invitation } from "../../src/db/schema";
import * as organizations from "../../src/organizations/organizations.server";
import * as projects from "../../src/organizations/projects.server";
import { data, expect, settingsUrl, test } from "./fixtures";

test.use({ timezoneId: "America/Los_Angeles" });

for (const locale of ["en", "fr"] as const) {
	test(`timestamps expose device, project, UTC and Unix conversions with copying and contextual settings in ${locale}`, async ({
		page,
		workspace,
	}) => {
		const options = { locale };
		const owner = await workspace.signIn(page, "time-owner@example.invalid");
		const org = data(
			await workspace.operations(owner.headers, () =>
				organizations.createOrganization(workspace.auth, owner.headers, {
					name: "Time lab",
					slug: "time-lab",
				}),
			),
		);
		const project = data(
			await workspace.operations(owner.headers, (actor) =>
				projects.createProject(workspace.database.db, actor, {
					organizationId: org.id,
					name: "Paris project",
					requestId: crypto.randomUUID(),
				}),
			),
		);
		data(
			await workspace.operations(owner.headers, (actor) =>
				projects.updateProjectCustomization(workspace.database.db, actor, {
					organizationId: org.id,
					projectId: project.id,
					action: "time-zone",
					timeZone: "Europe/Paris",
				}),
			),
		);
		const invited = await workspace.auth.api.createInvitation({
			headers: owner.headers,
			body: {
				organizationId: org.id,
				email: "time-recipient@example.invalid",
				role: "member",
			},
		});
		const instant = new Date("2026-06-23T17:37:00.123Z");
		await workspace.database.db
			.update(invitation)
			.set({ createdAt: instant })
			.where(eq(invitation.id, invited.id));
		await page
			.context()
			.addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
			]);
		await page.addInitScript(() =>
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (value: string) => {
						if (sessionStorage.getItem("fail-time-copy"))
							throw new Error("Clipboard denied");
						sessionStorage.setItem("copied-time", value);
					},
				},
			}),
		);
		const hydrationErrors: string[] = [];
		page.on("pageerror", (error) => hydrationErrors.push(error.message));
		page.on("console", (message) => {
			if (/hydration|did not match|Minified React error/i.test(message.text()))
				hydrationErrors.push(message.text());
		});
		const response = await page.goto(
			settingsUrl(
				`${workspace.origin}/organizations/${org.id}/projects/${project.id}`,
				"organization-members",
			),
		);
		expect(await response?.text()).toContain(instant.toISOString());
		const trigger = page.locator(
			`[data-slot="time-display"]:has(time[datetime="${instant.toISOString()}"])`,
		);
		await expect(trigger).toBeEnabled();
		await expect(trigger).toHaveCSS("text-decoration-line", "underline");
		await expect(trigger).toHaveCSS("text-decoration-style", "dotted");
		const faintUnderline = await trigger.evaluate(
			(element) => getComputedStyle(element).textDecorationColor,
		);
		await trigger.hover();
		await expect(trigger).not.toHaveCSS(
			"text-decoration-color",
			faintUnderline,
		);
		const popup = page.getByRole("dialog", {
			name: m.time_conversion({}, options),
			exact: true,
		});
		await expect(popup).toBeVisible();
		expect((await popup.boundingBox())?.width).toBeLessThanOrEqual(416);
		expect(
			await popup.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		const settings = popup.getByRole("link", {
			name: m.time_project_settings({}, options),
			exact: true,
		});
		await expect(settings).not.toBeFocused();
		await expect(popup.locator('[data-time-source="device"]')).toContainText(
			"10:37",
		);
		await expect(popup.locator('[data-time-source="project"]')).toContainText(
			locale === "fr" ? "19:37" : "7:37",
		);
		await expect(popup.locator('[data-time-source="utc"]')).toContainText(
			locale === "fr" ? "17:37" : "5:37",
		);
		await expect(popup.locator('[data-time-source="unix"]')).toContainText(
			String(instant.getTime() / 1000),
		);
		await popup
			.getByRole("button", {
				name: m.time_copy({ source: "UNIX" }, options),
				exact: true,
			})
			.click();
		expect(
			await page.evaluate(() => sessionStorage.getItem("copied-time")),
		).toBe(String(instant.getTime() / 1000));
		await page.evaluate(() => sessionStorage.setItem("fail-time-copy", "true"));
		await popup
			.getByRole("button", {
				name: m.time_copy({ source: "UTC" }, options),
				exact: true,
			})
			.click();
		await expect(popup.getByRole("status")).toHaveText(
			m.settings_copy_failed({}, options),
		);
		await page.keyboard.press("Escape");
		await expect(trigger).toBeFocused();
		await page.setViewportSize({ width: 390, height: 844 });
		await trigger.click();
		await expect(popup).toBeInViewport();
		expect(
			await popup.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await popup.screenshot({
			path: test.info().outputPath(`timezone-conversion-${locale}.png`),
		});
		await settings.click();
		await expect(page).toHaveURL(
			new RegExp(
				`section=project-customization.*organizationId=${org.id}.*projectId=${project.id}.*#project-time-zone`,
			),
		);
		await expect(page.locator("#project-time-zone")).toBeVisible();
		expect(hydrationErrors).toEqual([]);
	});
}

test("the content box edge is the only sidebar boundary and highlights while hovering, dragging and keyboard focused", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "edge-owner@example.invalid");
	const org = data(
		await workspace.operations(owner.headers, () =>
			organizations.createOrganization(workspace.auth, owner.headers, {
				name: "Edge lab",
				slug: "edge-lab",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projects.createProject(workspace.database.db, actor, {
				organizationId: org.id,
				name: "Edge project",
				requestId: crypto.randomUUID(),
			}),
		),
	);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(
		`${workspace.origin}/organizations/${org.id}/projects/${project.id}/executions`,
	);
	const sidebar = page.locator('[data-slot="sidebar-container"]');
	const main = page.locator('main[data-slot="sidebar-inset"]');
	const handle = page.getByRole("separator", {
		name: "Project navigation",
		exact: true,
	});
	await expect(
		page.getByRole("button", {
			name: "Switch project, organization or account",
			exact: true,
		}),
	).toBeEnabled();
	await expect(sidebar).toHaveCSS("border-right-width", "0px");
	const before = await main.boundingBox();
	const side = await sidebar.boundingBox();
	if (!before || !side) throw new Error("Expected the desktop shell");
	expect(before.x).toBeCloseTo(side.x + side.width, 0);
	const original = await main.evaluate(
		(element) => getComputedStyle(element).borderLeftColor,
	);
	await page.mouse.move(before.x, before.y + 200);
	await expect(handle).toHaveAttribute("data-separator", "hover");
	await expect(main).not.toHaveCSS("border-left-color", original);
	await expect(main).not.toHaveCSS("box-shadow", "none");
	await page.screenshot({
		path: test.info().outputPath("sidebar-edge-hover.png"),
	});
	await page.mouse.down();
	await page.mouse.move(290, before.y + 200, { steps: 8 });
	await expect(handle).toHaveAttribute("data-separator", "active");
	await expect(main).not.toHaveCSS("border-left-color", original);
	await page.mouse.up();
	expect((await sidebar.boundingBox())?.width).toBeGreaterThan(270);
	await page.mouse.move(900, 700);
	await expect(main).toHaveCSS("border-left-color", original);
	await handle.evaluate((element) => (element as HTMLElement).blur());
	await page.keyboard.press("Tab");
	await handle.focus();
	await expect(handle).toHaveAttribute("data-separator", "focus");
	await expect(main).not.toHaveCSS("border-left-color", original);
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(async () => (await sidebar.boundingBox())?.width ?? 0)
		.toBeGreaterThan(290);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(handle).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Open navigation", exact: true }),
	).toBeVisible();
});
