import {
	type AuthenticationRecovery,
	type AuthenticationState,
	provesNewAuthentication,
} from "./authentication-state";
import { settleIdentityRefresh } from "./refresh";

type Method = "verify" | "passkey" | "two-factor";
export type AuthenticationOutcome =
	| { status: "authenticated" }
	| { status: "two-factor-required" }
	| { status: "rejected"; code?: string; httpStatus?: number }
	| { status: "uncertain" }
	| { status: "canceled" };
export interface AuthenticationReply {
	twoFactorRequired?: boolean;
	ok: boolean;
	code?: string;
	httpStatus?: number;
}
export interface AuthenticationSnapshot {
	twoFactorPending: boolean;
	action: Method | "check" | null;
	pending: boolean;
	revision: number;
	recovery: AuthenticationRecovery | null;
	passkeyPromptFor: string | null;
}
export interface AuthenticationOperation {
	signal: AbortSignal;
	cancel: () => void;
	finish: () => void;
	// The callback must forward this independent signal to its native verification fetch.
	submit: (
		verify: (transportSignal: AbortSignal) => Promise<AuthenticationReply>,
		email?: string,
	) => Promise<AuthenticationOutcome>;
}
export interface AuthenticationController {
	getSnapshot: () => AuthenticationSnapshot;
	subscribe: (listener: () => void) => () => void;
	begin: (method: Method) => AuthenticationOperation | null;
	recover: () => Promise<AuthenticationOutcome>;
	beforePrivateRead: () => Promise<void>;
	clearRecovery: () => void;
	dismissPasskeyPrompt: (revision: number) => void;
}

export function createAuthenticationController(services: {
	readState: (signal?: AbortSignal) => Promise<AuthenticationState>;
	clearPrivateIdentity: () => void;
	refreshIdentity: () => Promise<void>;
	refreshTimeoutMs?: number;
	verificationTimeoutMs?: number;
}): AuthenticationController {
	let snapshot: AuthenticationSnapshot = {
		twoFactorPending: false,
		action: null,
		pending: false,
		revision: 0,
		recovery: null,
		passkeyPromptFor: null,
	};
	const listeners = new Set<() => void>();
	let active: {
		owner: symbol;
		controller: AbortController;
		submitted: boolean;
		settle: () => void;
		settled: Promise<void>;
	} | null = null;
	const publish = (change: Partial<AuthenticationSnapshot>) => {
		snapshot = { ...snapshot, ...change };
		for (const listener of listeners) listener();
	};
	const clear = () => {
		services.clearPrivateIdentity();
		publish({ revision: snapshot.revision + 1, passkeyPromptFor: null });
	};
	const refresh = async () => {
		await settleIdentityRefresh(
			services.refreshIdentity,
			services.refreshTimeoutMs,
		);
	};
	function acquire(action: Method | "check") {
		if (active) return null;
		let settle!: () => void;
		const operation = {
			owner: Symbol(action),
			controller: new AbortController(),
			submitted: false,
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
			settle: () => settle(),
		};
		active = operation;
		publish({ action, pending: true });
		const finish = () => {
			operation.settle();
			if (active === operation) {
				active = null;
				publish({ action: null, pending: false });
			}
		};
		return { operation, finish };
	}
	async function reconcile(
		recovery: AuthenticationRecovery,
		reply?: AuthenticationReply,
	): Promise<AuthenticationOutcome> {
		let current: AuthenticationState | undefined;
		try {
			current = await services.readState();
		} catch {
			/* A lost response is not proof that verification failed. */
		}
		clear();
		if (
			current &&
			provesNewAuthentication(recovery.baseline, current, recovery.email)
		) {
			publish({
				recovery: null,
				twoFactorPending: false,
				passkeyPromptFor:
					recovery.method === "verify" || recovery.method === "two-factor"
						? (current.session?.user.id ?? null)
						: null,
			});
			return { status: "authenticated" };
		}
		if (
			reply?.twoFactorRequired ||
			(current?.twoFactorPending &&
				recovery.method !== "two-factor" &&
				(!reply || reply.ok))
		) {
			publish({ recovery: null, twoFactorPending: true });
			return { status: "two-factor-required" };
		}
		if (
			reply &&
			!reply.ok &&
			reply.httpStatus &&
			reply.httpStatus >= 400 &&
			reply.httpStatus < 500 &&
			reply.httpStatus !== 408
		) {
			publish({
				recovery: null,
				twoFactorPending:
					current?.twoFactorPending ?? snapshot.twoFactorPending,
			});
			return {
				status: "rejected",
				code: reply.code,
				httpStatus: reply.httpStatus,
			};
		}
		publish({ recovery });
		return { status: "uncertain" };
	}
	return {
		getSnapshot: () => snapshot,
		dismissPasskeyPrompt(revision) {
			if (revision === snapshot.revision) publish({ passkeyPromptFor: null });
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		begin(method) {
			if (snapshot.recovery) return null;
			const lease = acquire(method);
			if (!lease) return null;
			const { operation, finish } = lease;
			return {
				signal: operation.controller.signal,
				cancel() {
					if (operation.submitted) return;
					operation.controller.abort();
					finish();
				},
				finish() {
					if (!operation.submitted) finish();
				},
				async submit(verify, email) {
					if (active !== operation || operation.controller.signal.aborted)
						return { status: "canceled" };
					let baseline: AuthenticationState;
					try {
						baseline = await services.readState(operation.controller.signal);
					} catch {
						finish();
						return { status: "canceled" };
					}
					if (active !== operation || operation.controller.signal.aborted)
						return { status: "canceled" };
					operation.submitted = true;
					clear();
					let reply: AuthenticationReply | undefined;
					const transport = new AbortController();
					let deadline: ReturnType<typeof setTimeout> | undefined;
					try {
						const expired = new Promise<undefined>((resolve) => {
							deadline = setTimeout(() => {
								// Abort the actual fetch before reconciliation can release its owner.
								transport.abort();
								resolve(undefined);
							}, services.verificationTimeoutMs ?? 30_000);
						});
						reply = await Promise.race([verify(transport.signal), expired]);
						if (transport.signal.aborted) reply = undefined;
					} catch {
						/* Reconcile rather than retrying a submitted authentication mutation. */
					} finally {
						clearTimeout(deadline);
						transport.abort();
					}
					try {
						// Retire other tabs' operations as soon as a response can have changed authentication cookies.
						clear();
						const outcome = await reconcile({ baseline, email, method }, reply);
						operation.settle();
						await refresh();
						return outcome;
					} finally {
						finish();
					}
				},
			};
		},
		async recover() {
			const recovery = snapshot.recovery;
			if (!recovery) return { status: "canceled" };
			const lease = acquire("check");
			if (!lease) return { status: "canceled" };
			try {
				const outcome = await reconcile(recovery);
				lease.operation.settle();
				await refresh();
				return outcome;
			} finally {
				lease.finish();
			}
		},
		async beforePrivateRead() {
			if (active) await active.settled;
			if (snapshot.recovery)
				throw new Error("Authentication could not be confirmed");
		},
		clearRecovery() {
			if (!active) publish({ recovery: null, twoFactorPending: false });
		},
	};
}
