import { m } from "@recount/i18n/messages";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { FingerprintPatternIcon } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	AuthenticationOperation,
	AuthenticationOutcome,
} from "../auth/authentication";
import { getAuthenticationState } from "../auth/authentication-state.functions";
import {
	passkeyAuthenticationSupported,
	preparePasskey,
} from "../auth/passkey";
import { ActionStack, DialogActions } from "./dialog-actions";
import { FormFeedback } from "./form-feedback";
import { useLocaleChangeBlocker } from "./locale-safety";
import { useMutationFeedback } from "./mutation-feedback";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Options = { userId: string; email: string; force?: boolean };
type RequestOwner = Options & {
	href: string;
	key: string | undefined;
	resolve: (verified: boolean) => void;
	trigger: HTMLElement | null;
};
const StepUpContext = createContext<
	((options: Options) => Promise<boolean>) | null
>(null);

function isFresh(
	state: Awaited<ReturnType<typeof getAuthenticationState>>,
	userId: string,
) {
	return (
		state.session?.user.id === userId &&
		state.session.user.emailVerified &&
		state.session.createdAt.getTime() <= state.observedAt.getTime() &&
		state.session.expiresAt.getTime() > state.observedAt.getTime() &&
		state.observedAt.getTime() - state.session.createdAt.getTime() <
			state.freshAgeSeconds * 1000
	);
}

type Phase = "choice" | "email" | "factor";

function rejectionMessage(
	outcome: { code?: string; httpStatus?: number },
	phase: Phase,
) {
	if (outcome.code === "ACCOUNT_CHANGED") return m.reauth_account_changed();
	if (outcome.httpStatus === 429) return m.code_rate_limited();
	if (phase === "factor") return m.two_factor_invalid();
	return m.code_invalid();
}

function operationKind(passkey: boolean, phase: Phase) {
	if (passkey) return "passkey";
	if (phase === "factor") return "two-factor";
	return "verify";
}

function verificationMethod(passkey: boolean, phase: Phase, backup: boolean) {
	if (passkey) return "passkey";
	if (phase !== "factor") return "email";
	return backup ? "backup" : "totp";
}

function codeLabel(phase: Phase, backup: boolean) {
	if (phase !== "factor") return m.signin_code();
	return backup
		? m.two_factor_recovery_code()
		: m.two_factor_authenticator_code();
}

export function StepUpAuthentication({ children }: { children: ReactNode }) {
	const { authentication } = getRouteApi("__root__").useRouteContext();
	const router = useRouter();
	const setFeedback = useMutationFeedback();
	const active = useRef<RequestOwner | null>(null);
	const lease = useRef<AuthenticationOperation | null>(null);
	const delivery = useRef<AbortController | null>(null);
	const restoreFocus = useRef<HTMLElement | null>(null);
	const codeInput = useRef<HTMLInputElement>(null);
	const [request, setRequest] = useState<RequestOwner | null>(null);
	const [phase, setPhase] = useState<"choice" | "email" | "factor">("choice");
	const [backup, setBackup] = useState(false);
	const [code, setCode] = useState("");
	const [message, setMessage] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [uncertain, setUncertain] = useState(false);
	const [retryAt, setRetryAt] = useState(0);
	const [now, setNow] = useState(0);
	const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
	useLocaleChangeBlocker(!!request);
	const finish = useCallback((owner: RequestOwner, verified: boolean) => {
		if (active.current !== owner) return;
		active.current = null;
		lease.current?.cancel();
		delivery.current?.abort();
		busy.current = false;
		setPending(false);
		setRequest(null);
		setCode("");
		restoreFocus.current = owner.trigger;
		owner.resolve(verified);
	}, []);
	useEffect(() => {
		const retire = () => {
			if (active.current) finish(active.current, false);
		};
		const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
			const owner = active.current;
			if (
				owner &&
				(toLocation.href !== owner.href ||
					toLocation.state.__TSR_key !== owner.key)
			)
				retire();
		});
		const stopBroadcast = getGlobalBroadcastChannel().subscribe(retire);
		const resolved = router.subscribe("onResolved", () => {
			const owner = active.current;
			if (
				owner &&
				router.state.matches.some(
					(match) =>
						"user" in match.context && match.context.user.id !== owner.userId,
				)
			)
				retire();
		});
		window.addEventListener("pagehide", retire);
		return () => {
			retire();
			stop();
			stopBroadcast();
			resolved();
			window.removeEventListener("pagehide", retire);
		};
	}, [router, finish]);
	useEffect(() => {
		if (!retryAt || Date.now() >= retryAt) return;
		const timer = setInterval(() => {
			setNow(Date.now());
			if (Date.now() >= retryAt) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	}, [retryAt]);
	useEffect(() => {
		if (phase !== "choice" && !uncertain) codeInput.current?.focus();
	}, [phase, uncertain]);
	async function requireStepUp(options: Options) {
		if (active.current || authentication.getSnapshot().pending) return false;
		let resolve!: (verified: boolean) => void;
		const promise = new Promise<boolean>((complete) => {
			resolve = complete;
		});
		const owner = {
			...options,
			href: router.state.location.href,
			key: router.state.location.state.__TSR_key,
			resolve,
			trigger:
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null,
		};
		active.current = owner;
		try {
			const state = await getAuthenticationState({
				signal: AbortSignal.timeout(10000),
			});
			if (active.current !== owner) return promise;
			if (state.session?.user.id !== options.userId) {
				finish(owner, false);
				await router.invalidate({ sync: true });
				return promise;
			}
			if (!options.force && isFresh(state, options.userId)) {
				finish(owner, true);
				return promise;
			}
			owner.email = state.session.user.email;
		} catch {
			if (active.current !== owner) return promise;
		}
		setPhase("choice");
		setBackup(false);
		setCode("");
		setMessage("");
		setUncertain(false);
		setRetryAt(0);
		setRequest(owner);
		return promise;
	}
	async function call(
		owner: RequestOwner,
		action: string,
		signal: AbortSignal,
		extra: object = {},
	) {
		const response = await fetch("/api/reauthentication", {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, userId: owner.userId, ...extra }),
			signal,
		});
		const data = await response.json();
		const verified = data.verified === true;
		const twoFactorRequired = data.twoFactorRequired === true;
		const ok =
			response.ok &&
			(action === "send"
				? data.sent === true
				: (verified && !twoFactorRequired) ||
					(action === "email" && twoFactorRequired && !verified));
		return {
			ok,
			verified: ok && verified,
			code: data.code as string | undefined,
			httpStatus: response.status,
			twoFactorRequired: ok && twoFactorRequired,
		};
	}
	async function present(
		owner: RequestOwner,
		outcome: AuthenticationOutcome,
		acknowledged = false,
	) {
		if (active.current !== owner) return;
		if (outcome.status === "authenticated") {
			const state = await getAuthenticationState({
				signal: AbortSignal.timeout(10000),
			});
			if (active.current !== owner) return;
			if (!isFresh(state, owner.userId)) {
				setMessage(m.reauth_account_changed());
				return;
			}
			authentication.dismissPasskeyPrompt(
				authentication.getSnapshot().revision,
			);
			finish(owner, acknowledged);
			if (!acknowledged) setFeedback(m.reauth_verified_retry());
		} else if (outcome.status === "two-factor-required") {
			setPhase("factor");
			setCode("");
			setUncertain(false);
		} else if (outcome.status === "uncertain") {
			setUncertain(true);
			setMessage(m.signin_uncertain());
		} else if (outcome.status === "rejected")
			setMessage(rejectionMessage(outcome, phase));
	}
	async function sendCode() {
		const owner = active.current;
		if (!owner || busy.current || remaining > 0) return;
		busy.current = true;
		setPending(true);
		setMessage("");
		const controller = new AbortController();
		delivery.current = controller;
		setNow(Date.now());
		setRetryAt(Date.now() + 60000);
		try {
			const result = await call(owner, "send", controller.signal);
			if (active.current !== owner) return;
			if (result.ok) {
				setPhase("email");
				setCode("");
			} else
				setMessage(
					result.httpStatus === 429
						? m.code_rate_limited()
						: m.code_request_failed(),
				);
		} catch {
			if (active.current === owner) {
				setPhase("email");
				setMessage(m.code_request_uncertain());
			}
		} finally {
			if (active.current === owner) {
				busy.current = false;
				setPending(false);
			}
		}
	}
	async function verify(passkey = false) {
		const owner = active.current;
		if (!owner || busy.current) return;
		busy.current = true;
		setPending(true);
		setMessage("");
		let operation: AuthenticationOperation | null = null;
		let acknowledged = false;
		try {
			if (uncertain) {
				await present(owner, await authentication.recover());
				return;
			}
			operation = authentication.begin(operationKind(passkey, phase));
			if (!operation) return;
			lease.current = operation;
			let extra: object = { code: code.trim() };
			if (passkey) {
				const prepared = await preparePasskey(operation.signal, false);
				if (active.current !== owner) return;
				if (prepared.status !== "ready") {
					setMessage(m.passkey_signin_was_not_completed_try_again_or());
					return;
				}
				extra = { response: prepared.assertion };
			}
			const outcome = await operation.submit(async (signal) => {
				const result = await call(
					owner,
					verificationMethod(passkey, phase, backup),
					signal,
					extra,
				);
				acknowledged = result.verified;
				return result;
			}, owner.email);
			await present(owner, outcome, acknowledged);
		} catch {
			if (active.current === owner) setMessage(m.signin_uncertain());
		} finally {
			operation?.finish();
			if (lease.current === operation) lease.current = null;
			if (active.current === owner) {
				busy.current = false;
				setPending(false);
			}
		}
	}
	return (
		<StepUpContext value={requireStepUp}>
			{children}
			<Dialog
				open={!!request}
				onOpenChange={(open) => {
					if (!open && !busy.current && active.current)
						finish(active.current, false);
				}}
			>
				<DialogContent
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
					}}
					className="sm:max-w-md"
					showCloseButton={!pending}
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
					onInteractOutside={(event) => {
						if (pending) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>{m.reauth_title()}</DialogTitle>
						<DialogDescription>{m.reauth_description()}</DialogDescription>
					</DialogHeader>
					{request && (
						<>
							<div className="flex flex-col gap-4">
								<p className="break-all text-sm text-muted-foreground">
									{request.email}
								</p>
								{phase === "choice" && !uncertain ? (
									<ActionStack>
										<Button
											onClick={() => void verify(true)}
											disabled={pending || !passkeyAuthenticationSupported()}
										>
											<FingerprintPatternIcon aria-hidden="true" />
											{m.sign_in_with_a_passkey()}
										</Button>
										<Button
											variant="outline"
											onClick={() => void sendCode()}
											disabled={pending || remaining > 0}
										>
											{remaining > 0
												? m.verify_code_in({ seconds: remaining })
												: m.send_code()}
										</Button>
									</ActionStack>
								) : (
									<form
										method="post"
										className="flex flex-col gap-4"
										onSubmit={(event) => {
											event.preventDefault();
											event.stopPropagation();
											void verify();
										}}
									>
										{!uncertain && (
											<div className="flex flex-col gap-2">
												<Label htmlFor="reauthentication-code">
													{codeLabel(phase, backup)}
												</Label>
												<Input
													ref={codeInput}
													id="reauthentication-code"
													value={code}
													onChange={(event) => setCode(event.target.value)}
													autoComplete="one-time-code"
													inputMode={backup ? "text" : "numeric"}
													pattern={backup ? undefined : "[0-9]{6}"}
													maxLength={backup ? 32 : 6}
													required
													disabled={pending}
												/>
											</div>
										)}
										<ActionStack>
											<Button
												type="submit"
												disabled={pending}
												pending={pending}
												pendingLabel={m.verifying_code()}
											>
												{uncertain ? m.checking_signin() : m.reauth_continue()}
											</Button>
											{phase === "factor" && !uncertain && (
												<Button
													type="button"
													variant="link"
													disabled={pending}
													onClick={() => {
														setBackup(!backup);
														setCode("");
														setMessage("");
													}}
												>
													{backup
														? m.two_factor_use_authenticator()
														: m.two_factor_use_recovery()}
												</Button>
											)}
											{phase === "email" && !uncertain && (
												<Button
													type="button"
													variant="link"
													disabled={pending || remaining > 0}
													onClick={() => void sendCode()}
												>
													{remaining > 0
														? m.resend_code_in({ seconds: remaining })
														: m.resend_code()}
												</Button>
											)}
										</ActionStack>
									</form>
								)}
								<FormFeedback
									message={message}
									kind={uncertain ? "warning" : "error"}
									reserveLine={false}
								/>
							</div>
							<DialogActions
								cancel={{
									label: m.cancel(),
									disabled: pending,
									onClick: () => finish(request, false),
								}}
							/>
						</>
					)}
				</DialogContent>
			</Dialog>
		</StepUpContext>
	);
}

export function useStepUpAuthentication() {
	const verify = useContext(StepUpContext);
	if (!verify)
		throw new Error("Step-up authentication requires its document provider");
	return verify;
}
