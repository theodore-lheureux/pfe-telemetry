import { m } from "@recount/i18n/messages";
import * as organizationDomain from "../../src/organizations/organizations.server";
import { data, expect, settingsUrl, test } from "./fixtures";

test("email-first login exposes localized errors and quiet footer preferences", async ({
	page,
	workspace,
}) => {
	let writes = 0;
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
		writes++;
		return route.fulfill({
			status: 400,
			json: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
		});
	});
	for (const locale of ["en", "fr"] as const) {
		for (const dark of [false, true]) {
			const options = { locale };
			await page.context().addCookies([
				{ name: "recount_locale", value: locale, url: workspace.origin },
				{
					name: "recount_theme",
					value: dark ? "tide-dark" : "tide",
					url: workspace.origin,
				},
			]);
			await page.setViewportSize({ width: 375, height: 900 });
			await page.goto(`${workspace.origin}/login`);
			const email = page.getByLabel(m.email_address({}, options), {
				exact: true,
			});
			await expect(email).toBeEnabled();
			await expect(email).toHaveAttribute("autocomplete", "username webauthn");
			const passkey = page.getByRole("button", {
				name: m.sign_in_with_a_passkey({}, options),
				exact: true,
			});
			await expect(
				passkey.locator("svg[aria-hidden=true]:visible"),
			).toHaveCount(1);
			expect(
				await passkey.evaluate((button) => {
					const input = document.getElementById("email");
					return (
						!!input &&
						!!(
							input.compareDocumentPosition(button) &
							Node.DOCUMENT_POSITION_FOLLOWING
						)
					);
				}),
			).toBe(true);
			await expect(
				page
					.locator("header")
					.getByLabel(m.language({}, options), { exact: true }),
			).toHaveCount(0);
			await expect(
				page
					.getByRole("contentinfo")
					.getByLabel(m.language({}, options), { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("contentinfo").getByRole("button", {
					name: dark
						? m.theme_switch_light({}, options)
						: m.theme_switch_dark({}, options),
				}),
			).toBeVisible();
			await email.fill("preview@example.invalid");
			await page
				.getByRole("button", {
					name: m.send_code({}, options),
					exact: true,
				})
				.click();
			const error = page.getByRole("alert");
			await expect(error).toContainText(m.code_request_failed({}, options));
			await expect(error.locator("svg[aria-hidden=true]")).toHaveCount(1);
			await expect(error).toHaveCSS(
				"color",
				dark ? "rgb(242, 139, 130)" : "rgb(185, 28, 28)",
			);
			await expect(email).toHaveValue("preview@example.invalid");
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
	}
	expect(writes).toBe(4);
});

test("conditional passkey waiting stays nonblocking and is canceled before email sign-in", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		const state = { started: 0, aborted: 0 };
		Object.assign(window, { conditionalTest: state });
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => true },
		);
		Object.defineProperty(navigator.credentials, "get", {
			configurable: true,
			value: (options: CredentialRequestOptions) =>
				new Promise((_resolve, reject) => {
					if (options.mediation !== "conditional")
						throw new Error("Unexpected modal request");
					state.started++;
					options.signal?.addEventListener(
						"abort",
						() => {
							state.aborted++;
							reject(new DOMException("Canceled", "AbortError"));
						},
						{ once: true },
					);
				}),
		});
	});
	let emailWrites = 0;
	let verifications = 0;
	page.on("request", (request) => {
		if (request.url().includes("/passkey/verify-authentication"))
			verifications++;
	});
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
		emailWrites++;
		return route.fulfill({
			status: 400,
			json: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
		});
	});
	await page.goto(`${workspace.origin}/login`);
	await page.waitForFunction(
		() =>
			(window as Window & { conditionalTest?: { started: number } })
				.conditionalTest?.started === 1,
	);
	await expect(
		page.getByRole("button", { name: "Sign in with a passkey", exact: true }),
	).toBeEnabled();
	await expect(page.getByLabel("Language", { exact: true })).toBeEnabled();
	await page
		.getByLabel("Email address", { exact: true })
		.fill("preview@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"We couldn’t request a code",
	);
	expect(
		await page.evaluate(
			() =>
				(window as Window & { conditionalTest?: { aborted: number } })
					.conditionalTest?.aborted,
		),
	).toBe(1);
	expect(emailWrites).toBe(1);
	expect(verifications).toBe(0);
});

test("a late conditional-capability result cannot start authentication after email submission", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{
				configurable: true,
				value: () =>
					new Promise<boolean>((resolve) => {
						Object.assign(window, { resolveConditional: resolve });
					}),
			},
		);
	});
	let optionsRequests = 0;
	page.on("request", (request) => {
		if (request.url().includes("/passkey/generate-authenticate-options"))
			optionsRequests++;
	});
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
		route.fulfill({ status: 200, json: { status: true } }),
	);
	await page.goto(`${workspace.origin}/login`);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("preview@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Check your email", exact: true }),
	).toBeVisible();
	await page.evaluate(async () => {
		(
			window as Window & { resolveConditional?: (supported: boolean) => void }
		).resolveConditional?.(true);
		await new Promise(requestAnimationFrame);
	});
	expect(optionsRequests).toBe(0);
});

test("a delayed conditional options response cannot reopen WebAuthn after email submission", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		Object.assign(window, { nativeRequests: 0 });
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => true },
		);
		Object.defineProperty(navigator.credentials, "get", {
			configurable: true,
			value: () => {
				Object.assign(window, { nativeRequests: 1 });
				return Promise.resolve(null);
			},
		});
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let optionsRequests = 0;
	await page.route(
		"**/api/auth/passkey/generate-authenticate-options",
		async (route) => {
			optionsRequests++;
			await held;
			try {
				await route.fulfill({
					status: 200,
					json: { challenge: "AA", rpId: "localhost", allowCredentials: [] },
				});
			} catch {
				/* Email submission deliberately aborts this held request. */
			}
		},
	);
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
		route.fulfill({ status: 200, json: { status: true } }),
	);
	await page.goto(`${workspace.origin}/login`);
	await expect.poll(() => optionsRequests).toBe(1);
	await page
		.getByLabel("Email address", { exact: true })
		.fill("preview@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Check your email", exact: true }),
	).toBeVisible();
	release();
	await page.evaluate(() => new Promise(requestAnimationFrame));
	expect(
		await page.evaluate(
			() => (window as Window & { nativeRequests?: number }).nativeRequests,
		),
	).toBe(0);
});

test("selected conditional authentication keeps submission ownership across navigation until settlement", async ({
	page,
	workspace,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => true },
		);
		Object.defineProperty(navigator.credentials, "get", {
			configurable: true,
			value: () =>
				new Promise((resolve) => {
					Object.assign(window, {
						chooseConditional: () => {
							const credential = Object.create(PublicKeyCredential.prototype);
							Object.defineProperties(credential, {
								response: {
									value: Object.create(
										AuthenticatorAssertionResponse.prototype,
									),
								},
								toJSON: {
									value: () => ({
										id: "fixture",
										rawId: "Zml4dHVyZQ",
										type: "public-key",
										clientExtensionResults: {},
										response: {
											authenticatorData: "AA",
											clientDataJSON: "AA",
											signature: "AA",
										},
									}),
								},
							});
							resolve(credential);
						},
					});
				}),
		});
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let verificationRequests = 0;
	let emailRequests = 0;
	await page.route(
		"**/api/auth/passkey/verify-authentication",
		async (route) => {
			verificationRequests++;
			await held;
			await route.fulfill({ status: 400, json: { code: "AUTH_CANCELLED" } });
		},
	);
	await page.route("**/api/auth/email-otp/send-verification-otp", (route) => {
		emailRequests++;
		return route.fulfill({ status: 200, json: { status: true } });
	});
	await page.goto(`${workspace.origin}/login`);
	const email = page.getByLabel("Email address", { exact: true });
	await email.fill("preview@example.invalid");
	await page.waitForFunction(
		() =>
			typeof (window as Window & { chooseConditional?: () => void })
				.chooseConditional === "function",
	);
	await page.evaluate(() => {
		(
			window as Window & { chooseConditional?: () => void }
		).chooseConditional?.();
		queueMicrotask(() => document.querySelector("form")?.requestSubmit());
	});
	await expect.poll(() => verificationRequests).toBe(1);
	await expect(email).toHaveAttribute("readonly", "");
	await expect(page.getByLabel("Language", { exact: true })).toBeDisabled();
	expect(emailRequests).toBe(0);
	await page
		.getByRole("link", { name: "Recount · Go home", exact: true })
		.click();
	release();
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await expect(email).toBeEnabled();
	await expect(page.getByLabel("Language", { exact: true })).toBeEnabled();
	await email.fill("preview@example.invalid");
	await page
		.getByRole("button", { name: "Continue with email", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Check your email", exact: true }),
	).toBeVisible();
	expect(emailRequests).toBe(1);
});

test("a selected saved passkey completes real verification and returns to the tenant", async ({
	page,
	workspace,
}) => {
	const owner = await workspace.signIn(page, "autofill@example.invalid");
	const organization = data(
		await workspace.operations(owner.headers, () =>
			organizationDomain.createOrganization(workspace.auth, owner.headers, {
				name: "Autofill workspace",
				slug: "autofill-workspace",
			}),
		),
	);
	await page.addInitScript(() => {
		Object.defineProperty(
			PublicKeyCredential,
			"isConditionalMediationAvailable",
			{ configurable: true, value: async () => true },
		);
		const nativeGet = navigator.credentials.get.bind(navigator.credentials);
		Object.defineProperty(navigator.credentials, "get", {
			configurable: true,
			value: (options: CredentialRequestOptions) => {
				if (options.mediation !== "conditional") return nativeGet(options);
				return new Promise((resolve, reject) => {
					// Simulate choosing an autofill entry; the virtual authenticator signs the real challenge.
					Object.assign(window, {
						chooseNativePasskey: () =>
							nativeGet({ ...options, mediation: "optional" }).then(
								resolve,
								reject,
							),
					});
					options.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Canceled", "AbortError")),
						{ once: true },
					);
				});
			},
		});
	});
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
	await page.getByLabel("Passkey name", { exact: true }).fill("Autofill key");
	await page
		.getByRole("button", { name: "Add a passkey", exact: true })
		.click();
	await expect(page.getByText("Autofill key", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	const destination = `/organizations/${organization.id}`;
	await page.goto(
		`${workspace.origin}/login?${new URLSearchParams({ redirect: destination })}`,
	);
	await page.waitForFunction(
		() =>
			typeof (window as Window & { chooseNativePasskey?: () => void })
				.chooseNativePasskey === "function",
	);
	await expect(page.getByLabel("Email address", { exact: true })).toBeEnabled();
	await page.evaluate(() =>
		(
			window as Window & { chooseNativePasskey?: () => void }
		).chooseNativePasskey?.(),
	);
	await expect(page).toHaveURL(workspace.origin + destination);
	await expect(
		page.getByRole("heading", { name: "Autofill workspace", exact: true }),
	).toBeVisible();
});
