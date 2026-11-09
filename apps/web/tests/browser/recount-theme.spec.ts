import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { m } from "@recount/i18n/messages";
import * as organizationDomain from "../../src/organizations/organizations.server";
import * as projectDomain from "../../src/organizations/projects.server";
import tokens from "../fixtures/recount-tokens.json" with { type: "json" };
import { data, expect, test } from "./fixtures";

const artifactDirectory = process.env.RECOUNT_ARTIFACT_DIR;

async function contrast(locator: Locator, property = "color") {
	return locator.evaluate((element, property) => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Color sampling unavailable");
		const ancestors: Element[] = [];
		for (let node: Element | null = element; node; node = node.parentElement)
			ancestors.unshift(node);
		for (const node of ancestors) {
			context.fillStyle = getComputedStyle(node).backgroundColor;
			context.fillRect(0, 0, 1, 1);
		}
		const background = context.getImageData(0, 0, 1, 1).data;
		context.fillStyle = getComputedStyle(element).getPropertyValue(property);
		context.fillRect(0, 0, 1, 1);
		const foreground = context.getImageData(0, 0, 1, 1).data;
		const luminance = (color: Uint8ClampedArray) =>
			[...color]
				.slice(0, 3)
				.map((value) => {
					const channel = value / 255;
					return channel <= 0.04045
						? channel / 12.92
						: ((channel + 0.055) / 1.055) ** 2.4;
				})
				.reduce(
					(sum, channel, index) =>
						sum + channel * [0.2126, 0.7152, 0.0722][index],
					0,
				);
		const a = luminance(background);
		const b = luminance(foreground);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	}, property);
}

async function noOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}

async function exactTokens(page: Page, dark: boolean) {
	const expected = {
		...tokens.colors[dark ? "dark" : "light"],
		...tokens.shape,
	};
	const actual = await page.locator("html").evaluate((element, names) => {
		const style = getComputedStyle(element);
		return Object.fromEntries(
			names.map((name) => {
				const value = style.getPropertyValue(name).trim();
				return [
					name,
					/^#[0-9a-f]{3}$/i.test(value)
						? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}`
						: value,
				];
			}),
		);
	}, Object.keys(expected));
	expect(actual).toEqual(expected);
}

test("cookie SSR, hydration, translated toggle and form state stay consistent", async ({
	page,
	workspace,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/hydration|did not match|Minified React error/i.test(message.text()))
			errors.push(message.text());
	});
	await Promise.all(
		[undefined, "tide", "tide-dark", "invalid"].flatMap((theme) =>
			["en", "fr"].map(async (locale) => {
				const response = await fetch(`${workspace.origin}/login`, {
					headers: {
						cookie: `recount_locale=${locale}${theme ? `; recount_theme=${theme}` : ""}`,
					},
				});
				const html = await response.text();
				expect(response.status).toBe(200);
				expect(html).toContain(
					`<html lang="${locale}" data-theme="${theme === "tide-dark" ? theme : "tide"}" data-variant="core">`,
				);
				expect(response.headers.get("cache-control")).toContain("no-store");
			}),
		),
	);
	for (const locale of ["en", "fr"] as const) {
		await page.context().addCookies([
			{ name: "recount_locale", value: locale, url: workspace.origin },
			{ name: "recount_theme", value: "tide-dark", url: workspace.origin },
		]);
		await page.goto(`${workspace.origin}/login`);
		const options = { locale };
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("link", {
				name: m.skip_to_content({}, options),
				exact: true,
			}),
		).toBeFocused();
		const email = page.getByLabel(m.email_address({}, options), {
			exact: true,
		});
		await email.fill("unsaved@example.invalid");
		await page
			.getByRole("button", { name: m.theme_switch_light({}, options) })
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "tide");
		await expect(email).toHaveValue("unsaved@example.invalid");
		await page
			.getByRole("button", { name: m.theme_switch_dark({}, options) })
			.focus();
		await page.keyboard.press("Enter");
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			"tide-dark",
		);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			"tide-dark",
		);
		await expect(
			page.getByRole("img", { name: "Recount", exact: true }),
		).toHaveCount(1);
		const missing = await page.goto(`${workspace.origin}/not-a-page`);
		expect(missing?.status()).toBe(404);
		await expect(
			page.getByRole("heading", {
				name: m.not_found({}, options),
				exact: true,
			}),
		).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			"tide-dark",
		);
		await page.setViewportSize({ width: 320, height: 900 });
		await noOverflow(page);
	}
	expect(errors).toEqual([]);
});

test("real workspace, credentials and administration retain Core geometry and keyboard behavior", async ({
	page,
	workspace,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/hydration|did not match|Minified React error/i.test(message.text()))
			errors.push(message.text());
	});
	const owner = await workspace.signIn(page, "recount-owner@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Recount integration workspace",
				slug: "recount-integration",
			}),
		),
	);
	const project = data(
		await workspace.operations(owner.headers, (actor) =>
			projectDomain.createProject(workspace.database.db, actor, {
				requestId: crypto.randomUUID(),
				organizationId: organization.id,
				name: "Private collector project",
				slug: "private-collector",
			}),
		),
	);
	const paths = {
		auth: "/login",
		workspace: "/",
		credentials: `/organizations/${organization.id}/projects/${project.id}/settings/credentials`,
		admin: `/organizations/${organization.id}/members`,
	};
	if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
	const results: object[] = [];
	for (const dark of [false, true]) {
		await page.context().addCookies([
			{
				name: "recount_theme",
				value: dark ? "tide-dark" : "tide",
				url: workspace.origin,
			},
		]);
		for (const [screen, path] of Object.entries(paths)) {
			for (const width of [1440, 768, 375, 320]) {
				await page.setViewportSize({ width, height: 1000 });
				await page.goto(workspace.origin + path);
				await expect(
					page.getByRole("button", {
						name: dark ? "Switch to light" : "Switch to dark",
					}),
				).toBeEnabled();
				const readyControl = page.getByLabel(
					screen === "workspace"
						? "Organization"
						: screen === "credentials"
							? "Credential name"
							: "Email address",
					{ exact: true },
				);
				await expect(readyControl).toBeEnabled();
				await expect(readyControl).toHaveCSS(
					"border-color",
					dark ? "rgb(157, 178, 185)" : "rgb(71, 90, 98)",
				);
				for (const button of await page
					.locator('[data-slot="button"]:enabled')
					.all())
					await expect(button).toHaveCSS("opacity", "1");
				await noOverflow(page);
				await exactTokens(page, dark);
				if (screen === "workspace" && width === 1440) {
					await page
						.getByRole("link", { name: "Skip to content", exact: true })
						.focus();
					await page.keyboard.press("Enter");
					await expect(page.locator("main")).toBeFocused();
				}
				const contrasts: Record<string, number> = {};
				if (width === 1440) {
					contrasts.heading = await contrast(page.locator("h1").first());
					contrasts.secondary = await contrast(
						page.locator("main .text-muted-foreground").first(),
					);
					const selected = page.locator("a.active").first();
					if (await selected.count())
						contrasts.selected = await contrast(selected);
					for (const value of Object.values(contrasts))
						expect(value).toBeGreaterThanOrEqual(4.5);
					const field = page.locator('[data-slot="input"]:enabled').first();
					if (await field.count()) {
						contrasts.field = await contrast(field, "border-top-color");
						expect(contrasts.field).toBeGreaterThanOrEqual(3);
					}
					const primary = page
						.locator('[data-slot="button"][data-variant="default"]:enabled')
						.first();
					if (await primary.count()) {
						contrasts.primary = await contrast(primary);
						await primary.hover();
						// Let the normal-motion transition reach the actual hover colors.
						await expect(primary).toHaveCSS(
							"background-color",
							dark ? "rgb(25, 62, 58)" : "rgb(220, 239, 236)",
						);
						contrasts.hover = await contrast(primary);
						await page.mouse.move(0, 0);
						await expect(primary).toHaveCSS(
							"background-color",
							dark ? "rgb(101, 214, 197)" : "rgb(15, 118, 110)",
						);
						expect(contrasts.primary).toBeGreaterThanOrEqual(4.5);
						expect(contrasts.hover).toBeGreaterThanOrEqual(4.5);
					}
				}
				const controls = await page
					.locator(
						'[data-slot="button"], [data-slot="input"], [data-slot="native-select"]',
					)
					.evaluateAll((elements) =>
						elements.map((element) => {
							const style = getComputedStyle(element);
							return {
								height: style.height,
								radius: style.borderRadius,
								font: style.fontSize,
							};
						}),
					);
				for (const control of controls)
					expect(control).toEqual({
						height: "32px",
						radius: "4px",
						font: "14px",
					});
				if (artifactDirectory && width !== 320)
					await page.screenshot({
						path: join(
							artifactDirectory,
							`${screen}-${dark ? "dark" : "light"}-${width}.png`,
						),
						fullPage: true,
					});
				results.push({
					screen,
					dark,
					width,
					overflow: false,
					tokens: "exact",
					controls: controls.length,
					contrasts,
				});
			}
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.evaluate(() => {
				document.documentElement.style.zoom = "2";
			});
			await noOverflow(page);
			await page.evaluate(() => {
				document.documentElement.style.zoom = "";
			});
		}
		await page.setViewportSize({ width: 320, height: 900 });
		await page.goto(`${workspace.origin}/login`);
		const sendCode = "**/api/auth/email-otp/send-verification-otp";
		await page.route(sendCode, (route) =>
			route.fulfill({ status: 400, json: { message: "Invalid request" } }),
		);
		await page
			.getByLabel("Email address", { exact: true })
			.fill("theme@example.invalid");
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		const error = page.getByRole("alert");
		await expect(error).toBeVisible();
		const errorContrast = await contrast(error);
		await page.unroute(sendCode);
		expect(errorContrast).toBeGreaterThanOrEqual(4.5);
		await noOverflow(page);
		results.push({
			screen: "auth-error",
			dark,
			width: 320,
			overflow: false,
			contrast: errorContrast,
		});
	}
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(workspace.origin + paths.credentials);
	const name = page.getByLabel("Credential name", { exact: true });
	const credentialName = "ThemeLifecycle".repeat(8);
	await name.fill(credentialName);
	await page.getByLabel("Source ID", { exact: true }).fill("theme-source");
	const root = page.getByRole("textbox", {
		name: m.enrolled_root_id({}, { locale: "en" }),
		exact: true,
	});
	await expect(root).toHaveAttribute("required", "");
	await expect(root).toHaveAccessibleDescription(
		m.enrolled_root_help({}, { locale: "en" }),
	);
	const create = page.getByRole("button", {
		name: "Create credential",
		exact: true,
	});
	await create.focus();
	await page.keyboard.press("Enter");
	await expect(root).toBeFocused();
	expect(
		await root.evaluate(
			(element: HTMLInputElement) => element.validity.valueMissing,
		),
	).toBe(true);
	const token = page.getByLabel("One-time collector token", { exact: true });
	await expect(token).toHaveCount(0);
	await page.keyboard.type("theme-host");
	await expect(root).toHaveValue("theme-host");
	const timing = page.locator("details").filter({
		hasText: m.submission_timing_policy({}, { locale: "en" }),
	});
	const timingToggle = timing.locator("summary");
	await timingToggle.focus();
	await expect(timingToggle).toBeFocused();
	await page.keyboard.press("Space");
	await expect(timing).toHaveAttribute("open", "");
	await page.keyboard.press("Space");
	await expect(timing).not.toHaveAttribute("open", "");
	await create.focus();
	await page.keyboard.press("Enter");
	await expect(token).toBeVisible();
	const initialToken = await token.inputValue();
	await page
		.getByRole("button", { name: "Switch to light", exact: true })
		.click();
	expect((await token.inputValue()) === initialToken).toBe(true);
	await expect(page.getByLabel("Language", { exact: true })).toBeDisabled();
	await page
		.getByRole("button", { name: "I saved the token — hide it", exact: true })
		.click();
	await expect(token).toHaveCount(0);
	const rotate = page.getByRole("button", {
		name: `Rotate ${credentialName}`,
		exact: true,
	});
	await rotate.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
	await expect(dialog).toHaveCSS("border-radius", "4px");
	await page.setViewportSize({ width: 320, height: 900 });
	expect(
		await dialog.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	const animationDuration = await dialog.evaluate(
		(element) => getComputedStyle(element).animationDuration,
	);
	expect(parseFloat(animationDuration)).toBeLessThanOrEqual(0.00001);
	for (let index = 0; index < 5; index++) {
		await page.keyboard.press("Tab");
		expect(
			await dialog.evaluate((element) =>
				element.contains(document.activeElement),
			),
		).toBe(true);
	}
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(rotate).toBeFocused();
	await expect(rotate).toHaveCSS("border-color", "rgb(15, 118, 110)");
	const focus = await rotate.evaluate((element) => ({
		shadow: getComputedStyle(element).boxShadow,
		border: getComputedStyle(element).borderColor,
	}));
	expect(focus.shadow).not.toBe("none");
	expect(focus.border).toBe("rgb(15, 118, 110)");
	await page
		.getByRole("button", { name: "Switch to dark", exact: true })
		.click();
	await rotate.click();
	await expect(dialog).toHaveCSS("background-color", "rgb(19, 36, 41)");
	await page.keyboard.press("Escape");
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "tide-dark");
	await page.goBack();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "tide-dark");
	await page.goto(workspace.origin);
	await page.route("**/_serverFn/**", (route) => route.abort());
	await page.getByRole("link", { name: new RegExp(organization.name) }).click();
	await expect(
		page.getByRole("heading", { name: "Something went wrong" }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "tide-dark");
	await noOverflow(page);
	expect(
		await contrast(page.locator('[data-slot="alert-description"]')),
	).toBeGreaterThanOrEqual(4.5);
	await page.unroute("**/_serverFn/**");
	for (const dark of [false, true]) {
		await page.context().addCookies([
			{ name: "recount_locale", value: "fr", url: workspace.origin },
			{
				name: "recount_theme",
				value: dark ? "tide-dark" : "tide",
				url: workspace.origin,
			},
		]);
		for (const width of [1440, 768, 375, 320]) {
			await page.setViewportSize({ width, height: 1000 });
			await page.goto(workspace.origin + paths.admin);
			await expect(
				page.getByLabel(m.email_address({}, { locale: "fr" }), { exact: true }),
			).toBeEnabled();
			await noOverflow(page);
			if (artifactDirectory)
				await page.screenshot({
					path: join(
						artifactDirectory,
						`admin-fr-${dark ? "dark" : "light"}-${width}.png`,
					),
					fullPage: true,
				});
			results.push({
				screen: "admin",
				locale: "fr",
				dark,
				width,
				overflow: false,
			});
		}
		await page.goto(workspace.origin + paths.credentials);
		await page
			.getByRole("button", {
				name: m.rotate_named({ name: credentialName }, { locale: "fr" }),
				exact: true,
			})
			.click();
		await expect(dialog).toHaveAccessibleName(
			m.confirm_rotate_named({ name: credentialName }, { locale: "fr" }),
		);
		expect(
			await dialog.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await noOverflow(page);
		if (artifactDirectory)
			await page.screenshot({
				path: join(
					artifactDirectory,
					`credential-dialog-fr-${dark ? "dark" : "light"}-320.png`,
				),
			});
		await page.keyboard.press("Escape");
	}
	expect(errors).toEqual([]);
	if (artifactDirectory)
		await writeFile(
			join(artifactDirectory, "browser-results.json"),
			JSON.stringify(
				{
					results,
					errors,
					zoom: "200% CSS zoom on each screen/mode",
					keyboard:
						"toggle, required root entry, timing disclosure, real credential dialog containment/Escape/focus return",
					token: "preserved through mode change, dismissed before artifacts",
				},
				null,
				2,
			),
		);
});
