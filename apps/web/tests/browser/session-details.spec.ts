import { chooseTheme, expect, test } from "./fixtures";

test("theme dropdown persists light, dark and CSS-native system mode without losing form state", async ({
	page,
	browser,
	workspace,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(`${workspace.origin}/login`);
	const email = page.getByLabel("Email address", { exact: true });
	await email.fill("unsaved-theme@example.invalid");
	await chooseTheme(page, "system");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(12, 24, 28)",
	);
	await page.emulateMedia({ colorScheme: "light" });
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(245, 247, 248)",
	);
	await expect(email).toHaveValue("unsaved-theme@example.invalid");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
	await chooseTheme(page, "dark");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(12, 24, 28)",
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await chooseTheme(page, "light");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(245, 247, 248)",
	);
	const plain = await browser.newContext({
		javaScriptEnabled: false,
		colorScheme: "dark",
	});
	try {
		await plain.addCookies([
			{ name: "recount_theme", value: "system", url: workspace.origin },
		]);
		const plainPage = await plain.newPage();
		await plainPage.goto(`${workspace.origin}/login`);
		await expect(plainPage.locator("html")).toHaveAttribute(
			"data-theme",
			"system",
		);
		await expect(plainPage.locator("body")).toHaveCSS(
			"background-color",
			"rgb(12, 24, 28)",
		);
		await expect(plainPage.locator('img[src$="on-dark.svg"]')).toBeVisible();
	} finally {
		await plain.close();
	}
});

test("form borders are softer in both themes without losing focus or invalid-field styling", async ({
	page,
	workspace,
}) => {
	await workspace.signIn(page, "soft-fields@example.invalid");
	for (const dark of [false, true]) {
		await page.context().addCookies([
			{
				name: "recount_theme",
				value: dark ? "tide-dark" : "tide",
				url: workspace.origin,
			},
		]);
		await page.goto(`${workspace.origin}/settings?section=user`);
		const name = page.getByLabel("Name", { exact: true });
		await expect(name).toBeEnabled();
		await expect(name).toHaveCSS(
			"border-color",
			dark ? "rgb(88, 113, 122)" : "rgb(131, 145, 150)",
		);
		await name.focus();
		await expect(name).toHaveCSS(
			"border-color",
			dark ? "rgb(101, 214, 197)" : "rgb(15, 118, 110)",
		);
		await name.fill(" ");
		await name.blur();
		await expect(name).toHaveAttribute("aria-invalid", "true");
	}
});

test("email sign-in offers optional passkey enrollment and records the actual sign-in method", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => false },
		);
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	);
	try {
		await workspace.enableCodeDelivery(page);
		await page.goto(`${workspace.origin}/login`);
		const email = "passkey-prompt@example.invalid";
		await page.getByLabel("Email address", { exact: true }).fill(email);
		await page
			.getByRole("button", { name: "Continue with email", exact: true })
			.click();
		await workspace.submitReceivedCode(page, email);
		const prompt = page.getByRole("dialog", {
			name: "Make your next sign-in easier",
			exact: true,
		});
		await expect(prompt).toBeVisible();
		await expect(
			prompt.getByRole("button", { name: "Not now", exact: true }),
		).toBeFocused();
		for (let index = 0; index < 4; index++) {
			await page.keyboard.press("Tab");
			expect(
				await prompt.evaluate((element) =>
					element.contains(document.activeElement),
				),
			).toBe(true);
		}
		expect(
			(
				await (
					await page.request.get(`${workspace.origin}/api/auth/get-session`)
				).json()
			).session.signInMethod,
		).toBe("email-otp");
		await prompt
			.getByRole("link", { name: "Set up a passkey", exact: true })
			.click();
		await expect(prompt).toHaveCount(0);
		await page
			.getByLabel("Passkey name", { exact: true })
			.fill("Fixture device");
		await page
			.getByRole("button", { name: "Add a passkey", exact: true })
			.click();
		await expect(
			page.getByRole("cell", { name: "Fixture device", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await page
			.getByRole("button", { name: "Sign in with a passkey", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Your organizations", exact: true }),
		).toBeVisible();
		expect(
			(
				await (
					await page.request.get(`${workspace.origin}/api/auth/get-session`)
				).json()
			).session.signInMethod,
		).toBe("passkey");
		await expect(prompt).toHaveCount(0);
	} finally {
		await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
		await cdp.detach();
	}
});
