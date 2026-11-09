import { expect, test } from "./fixtures";

for (const stage of ["options", "ceremony"] as const) {
	test(`manual passkey cancellation owns the ${stage} stage without native JSON helpers`, async ({
		page,
		workspace,
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(
				PublicKeyCredential,
				"parseRequestOptionsFromJSON",
				{ configurable: true, value: undefined },
			);
			Object.defineProperty(PublicKeyCredential.prototype, "toJSON", {
				configurable: true,
				value: undefined,
			});
			const state = { started: 0, aborted: 0, conditional: false };
			Object.assign(window, { manualPasskeyTest: state });
			Object.defineProperty(navigator.credentials, "get", {
				configurable: true,
				value: (options: CredentialRequestOptions) =>
					new Promise((_resolve, reject) => {
						state.started++;
						state.conditional = options.mediation === "conditional";
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
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let optionsRequests = 0;
		let verifications = 0;
		page.on("request", (request) => {
			if (request.url().includes("/passkey/verify-authentication"))
				verifications++;
		});
		await page.route(
			"**/api/auth/passkey/generate-authenticate-options",
			async (route) => {
				optionsRequests++;
				if (stage === "options") await held;
				await route
					.fulfill({
						status: 200,
						json: { challenge: "AA", rpId: "localhost", allowCredentials: [] },
					})
					.catch(() => {});
			},
		);
		try {
			await page.goto(`${workspace.origin}/login`);
			await page
				.getByRole("button", { name: "Sign in with a passkey", exact: true })
				.click();
			await expect.poll(() => optionsRequests).toBe(1);
			if (stage === "ceremony")
				await page.waitForFunction(
					() =>
						(window as Window & { manualPasskeyTest?: { started: number } })
							.manualPasskeyTest?.started === 1,
				);
			await page.evaluate(() =>
				window.dispatchEvent(
					new PageTransitionEvent("pagehide", { persisted: true }),
				),
			);
			release();
			await expect(
				page.getByRole("button", { name: "Continue with email", exact: true }),
			).toBeEnabled();
			await page.evaluate(() => new Promise(requestAnimationFrame));
			const state = await page.evaluate(
				() =>
					(
						window as Window & {
							manualPasskeyTest?: {
								started: number;
								aborted: number;
								conditional: boolean;
							};
						}
					).manualPasskeyTest,
			);
			expect(state).toEqual({
				started: stage === "ceremony" ? 1 : 0,
				aborted: stage === "ceremony" ? 1 : 0,
				conditional: false,
			});
			expect(verifications).toBe(0);
		} finally {
			release();
		}
	});
}
