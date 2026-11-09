import { expect, test } from "./fixtures";

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
		await expect(
			page.getByRole("heading", { name: "Your organizations", exact: true }),
		).toBeVisible();
		const prompt = page.getByRole("region", {
			name: "Make your next sign-in easier",
			exact: true,
		});
		await expect(prompt).toBeVisible();
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
