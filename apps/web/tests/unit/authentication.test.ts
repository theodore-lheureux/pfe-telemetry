import { expect, test } from "bun:test";
import { createAuthenticationController } from "../../src/auth/authentication";
import {
	type AuthenticationState,
	provesNewAuthentication,
} from "../../src/auth/authentication-state";

function state(
	id: string | null,
	created = 0,
	observed = 1000,
	email = "a@example.invalid",
): AuthenticationState {
	return {
		observedAt: new Date(observed),
		freshAgeSeconds: 600,
		session: id
			? {
					id,
					createdAt: new Date(created),
					expiresAt: new Date(1_000_000),
					user: { id: email, email, emailVerified: true },
				}
			: null,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
test("submitted authentication retains ownership after cancellation and refreshes identity without a UI owner", async () => {
	const response = deferred<{ ok: boolean }>();
	const states = [state("a"), state("b", 1001, 1002, "b@example.invalid")];
	let clears = 0;
	let refreshes = 0;
	const controller = createAuthenticationController({
		readState: async () => {
			const next = states.shift();
			if (!next) throw new Error("Unexpected read");
			return next;
		},
		clearPrivateIdentity: () => {
			clears++;
		},
		refreshIdentity: async () => {
			await controller.beforePrivateRead();
			refreshes++;
		},
	});
	const operation = controller.begin("verify");
	if (!operation) throw new Error("Expected operation");
	const result = operation.submit(() => response.promise, "b@example.invalid");
	await Promise.resolve();
	operation.cancel();
	operation.finish();
	expect(operation.signal.aborted).toBe(false);
	expect(controller.getSnapshot().pending).toBe(true);
	expect(controller.begin("passkey")).toBeNull();
	response.resolve({ ok: true });
	expect((await result).status).toBe("authenticated");
	expect(clears >= 2).toBe(true);
	expect(refreshes).toBe(1);
	expect(controller.getSnapshot().pending).toBe(false);
	expect(controller.getSnapshot().passkeyPromptFor).toBe("b@example.invalid");
	const revision = controller.getSnapshot().revision;
	controller.dismissPasskeyPrompt(revision - 1);
	expect(controller.getSnapshot().passkeyPromptFor).toBe("b@example.invalid");
	controller.dismissPasskeyPrompt(revision);
	expect(controller.getSnapshot().passkeyPromptFor).toBeNull();
});
test("pre-submit cancellation prevents verification rather than turning it into an authentication mutation", async () => {
	let posts = 0;
	const controller = createAuthenticationController({
		readState: async () => state(null),
		clearPrivateIdentity: () => {},
		refreshIdentity: async () => {},
	});
	const operation = controller.begin("passkey");
	if (!operation) throw new Error("Expected operation");
	operation.cancel();
	expect(operation.signal.aborted).toBe(true);
	expect(
		(
			await operation.submit(async () => {
				posts++;
				return { ok: true };
			})
		).status,
	).toBe("canceled");
	expect(posts).toBe(0);
	expect(controller.getSnapshot().pending).toBe(false);
});
test("stalled identity revalidation cannot retain ownership after verification has settled", async () => {
	const states = [state(null), state("new", 1001, 1002)];
	const controller = createAuthenticationController({
		readState: async () => {
			const next = states.shift();
			if (!next) throw new Error("Unexpected read");
			return next;
		},
		clearPrivateIdentity: () => {},
		refreshIdentity: () => new Promise(() => {}),
		refreshTimeoutMs: 5,
	});
	const operation = controller.begin("verify");
	if (!operation) throw new Error("Expected operation");
	expect((await operation.submit(async () => ({ ok: true }))).status).toBe(
		"authenticated",
	);
	expect(controller.getSnapshot().pending).toBe(false);
	await controller.beforePrivateRead();
	expect(controller.begin("verify")).not.toBeNull();
});
for (const method of ["verify", "passkey"] as const) {
	test(`${method} transport deadline aborts before reconciliation and ignores late settlement`, async () => {
		const started = deferred<AbortSignal>();
		const late = deferred<{ ok: boolean }>();
		let transport: AbortSignal | undefined;
		let reads = 0;
		let posts = 0;
		let clears = 0;
		const controller = createAuthenticationController({
			readState: async () => {
				if (reads++ > 0) expect(transport?.aborted).toBe(true);
				return state("old");
			},
			clearPrivateIdentity: () => {
				clears++;
			},
			refreshIdentity: async () => {},
			verificationTimeoutMs: 5,
		});
		const operation = controller.begin(method);
		if (!operation) throw new Error("Expected operation");
		const result = operation.submit((signal) => {
			transport = signal;
			posts++;
			started.resolve(signal);
			return late.promise;
		}, "a@example.invalid");
		const signal = await started.promise;
		const privateRead = controller.beforePrivateRead().then(
			() => "allowed",
			() => "blocked",
		);
		operation.cancel();
		operation.finish();
		expect(signal.aborted).toBe(false);
		expect(operation.signal.aborted).toBe(false);
		expect(controller.getSnapshot().pending).toBe(true);
		expect(controller.begin("verify")).toBeNull();
		expect((await result).status).toBe("uncertain");
		expect(signal.aborted).toBe(true);
		expect(await privateRead).toBe("blocked");
		expect(controller.getSnapshot().pending).toBe(false);
		expect(controller.getSnapshot().recovery?.baseline.session?.id).toBe("old");
		expect(clears >= 2).toBe(true);
		expect(posts).toBe(1);
		expect((await controller.recover()).status).toBe("uncertain");
		expect(posts).toBe(1);
		controller.clearRecovery();
		const next = controller.begin("verify");
		if (!next) throw new Error("Expected new operation after transport abort");
		late.resolve({ ok: true });
		await Promise.resolve();
		expect(controller.getSnapshot().pending).toBe(true);
		next.cancel();
	});
}
for (const cookieApplied of [false, true]) {
	const expectation = cookieApplied
		? "accepts a new session"
		: "rejects the old session";
	test(`timeout after server commit ${expectation}`, async () => {
		let reads = 0;
		let aborted = false;
		const controller = createAuthenticationController({
			readState: async () => {
				if (reads++ === 0) return state("old");
				expect(aborted).toBe(true);
				return cookieApplied ? state("new", 1001, 1002) : state("old");
			},
			clearPrivateIdentity: () => {},
			refreshIdentity: async () => {},
			verificationTimeoutMs: 5,
		});
		const operation = controller.begin("verify");
		if (!operation) throw new Error("Expected operation");
		const result = await operation.submit((signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			return new Promise(() => {});
		}, "a@example.invalid");
		expect(result.status).toBe(cookieApplied ? "authenticated" : "uncertain");
		expect(controller.getSnapshot().pending).toBe(false);
	});
}
test("an old matching-email session never satisfies uncertain verification or recovery", async () => {
	let posts = 0;
	const controller = createAuthenticationController({
		readState: async () => state("old", 0, 1000),
		clearPrivateIdentity: () => {},
		refreshIdentity: async () => {},
	});
	const operation = controller.begin("verify");
	if (!operation) throw new Error("Expected operation");
	expect(
		(
			await operation.submit(async () => {
				posts++;
				throw new Error("Lost response");
			}, "a@example.invalid")
		).status,
	).toBe("uncertain");
	expect((await controller.recover()).status).toBe("uncertain");
	expect(posts).toBe(1);
	expect(controller.begin("verify")).toBeNull();
	await expect(controller.beforePrivateRead()).rejects.toThrow(
		"Authentication could not be confirmed",
	);
	controller.clearRecovery();
	expect(controller.begin("verify")).not.toBeNull();
});
test("freshness proof checks session identity, server time, verification, email and expiry", () => {
	const baseline = state("baseline", 0, 1000);
	expect(provesNewAuthentication(baseline, state("baseline", 1001, 1002))).toBe(
		false,
	);
	expect(
		provesNewAuthentication(baseline, state("another-old", 999, 1002)),
	).toBe(false);
	expect(
		provesNewAuthentication(
			baseline,
			state("new", 1001, 1002),
			"b@example.invalid",
		),
	).toBe(false);
	expect(provesNewAuthentication(baseline, state("new", 1003, 1002))).toBe(
		false,
	);
	expect(provesNewAuthentication(baseline, state("new", 1001, 1002))).toBe(
		true,
	);
	const unverified = state("new", 1001, 1002);
	if (unverified.session) unverified.session.user.emailVerified = false;
	expect(provesNewAuthentication(baseline, unverified)).toBe(false);
	expect(provesNewAuthentication(baseline, state("stale", 1001, 700_000))).toBe(
		false,
	);
});
