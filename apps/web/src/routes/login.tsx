import { m } from "@recount/i18n/messages";
import {
	createFileRoute,
	type SearchSchemaInput,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowLeftIcon, FingerprintPatternIcon } from "lucide-react";
import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type {
	AuthenticationOperation,
	AuthenticationOutcome,
} from "../auth/authentication";
import { getAuthenticationState } from "../auth/authentication-state.functions";
import { authClient } from "../auth/client";
import {
	passkeyAuthenticationSupported,
	preparePasskey,
} from "../auth/passkey";
import { loginSearch } from "../auth/redirect";
import { readSignInLink } from "../auth/sign-in-link";
import { useAppForm } from "../components/app-form";
import { AuthCard, AuthDivider } from "../components/auth-card";
import { ActionStack } from "../components/dialog-actions";
import { type FeedbackKind, FormFeedback } from "../components/form-feedback";
import { useLocaleChangeBlocker } from "../components/locale-safety";
import { useMutationFeedback } from "../components/mutation-feedback";
import { TwoFactorSignIn } from "../components/two-factor-sign-in";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "../components/ui/input-otp";
import { currentOrigin } from "../lib/origin";

export const Route = createFileRoute("/login")({
	loader: async () => ({
		twoFactorPending: (await getAuthenticationState()).twoFactorPending,
	}),
	staleTime: 0,
	gcTime: 0,
	headers: () => ({ "Cache-Control": "private, no-store" }),
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
		loginSearch(search, currentOrigin()),
	head: () => ({ meta: [{ title: `${m.sign_in()} · ${m.app_title()}` }] }),
	component: Login,
});

type Action = "send" | "resend" | "verify" | "check" | "passkey";
type Message = { kind: FeedbackKind; text: string };

function Login() {
	const loaded = Route.useLoaderData();
	const [factorDismissed, setFactorDismissed] = useState(false);
	const { redirect } = Route.useSearch();
	const { authentication } = Route.useRouteContext();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useMutationFeedback();
	const [phase, setPhase] = useState<"email" | "code">(
		identity.recovery?.email ? "code" : "email",
	);
	const [sentEmail, setSentEmail] = useState(identity.recovery?.email ?? "");
	const [localAction, setAction] = useState<Action | null>(null);
	const action = localAction ?? identity.action;
	const [message, setMessage] = useState<Message | null>(null);
	const [codeInvalid, setCodeInvalid] = useState(false);
	const [uncertain, setUncertain] = useState(!!identity.recovery);
	const [retryAt, setRetryAt] = useState(0);
	const [verifyRetryAt, setVerifyRetryAt] = useState(0);
	const [sendRateLimited, setSendRateLimited] = useState(false);
	const [now, setNow] = useState(0);
	const lifetime = useRef({ mounted: false, generation: 0 });
	const operation = useRef<symbol | null>(null);
	const request = useRef<{ cancel: () => void } | null>(null);
	const conditional = useRef<{ cancel: () => void } | null>(null);
	const previousPhase = useRef(phase);
	const emailInput = useRef<HTMLInputElement>(null);
	const codeInput = useRef<HTMLInputElement>(null);
	const emailForm = useAppForm({
		defaultValues: { email: "" },
		onSubmit: async ({ value }) => requestCode(value.email, false),
	});
	const codeForm = useAppForm({
		defaultValues: { code: "" },
		onSubmit: async ({ value }) => verifyCode(value.code),
	});
	const busy = localAction !== null || identity.pending;
	const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
	const verifyRemaining = Math.max(0, Math.ceil((verifyRetryAt - now) / 1000));
	const passkeysSupported = hydrated ? passkeyAuthenticationSupported() : null;
	useLocaleChangeBlocker(busy);

	useEffect(() => {
		const state = lifetime.current;
		state.mounted = true;
		const stop = router.subscribe(
			"onBeforeNavigate",
			({ fromLocation, toLocation }) => {
				if (
					fromLocation?.href !== toLocation.href ||
					fromLocation?.state.__TSR_key !== toLocation.state.__TSR_key
				) {
					state.generation++;
					conditional.current?.cancel();
					request.current?.cancel();
				}
			},
		);
		const hide = () => {
			state.generation++;
			conditional.current?.cancel();
			request.current?.cancel();
			codeForm.reset();
		};
		window.addEventListener("pagehide", hide);
		return () => {
			state.mounted = false;
			state.generation++;
			hide();
			window.removeEventListener("pagehide", hide);
			stop();
		};
	}, [router, codeForm]);
	useEffect(() => {
		const deadline = Math.max(retryAt, verifyRetryAt);
		if (!deadline || Date.now() >= deadline) return;
		setNow(Date.now());
		const interval = window.setInterval(() => {
			const time = Date.now();
			setNow(time);
			if (time >= deadline) window.clearInterval(interval);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [retryAt, verifyRetryAt]);
	useEffect(() => {
		if (previousPhase.current === phase) return;
		previousPhase.current = phase;
		(phase === "code" ? codeInput.current : emailInput.current)?.focus();
	}, [phase]);

	// A link from the sign-in email opens the code step with the code filled in. The fragment
	// is dropped from the address bar and history before anything else happens.
	const openSignInLink = useEffectEvent(() => {
		const link = readSignInLink(window.location.hash);
		if (!link) return;
		window.history.replaceState(
			window.history.state,
			"",
			window.location.pathname + window.location.search,
		);
		if (operation.current || authentication.getSnapshot().pending) return;
		conditional.current?.cancel();
		authentication.clearRecovery();
		setSentEmail(link.email);
		codeForm.setFieldValue("code", link.code);
		setCodeInvalid(false);
		setUncertain(false);
		setMessage(null);
		setPhase("code");
	});
	useEffect(() => {
		if (hydrated) openSignInLink();
	}, [hydrated]);

	async function presentAuthentication(
		outcome: AuthenticationOutcome,
		current: () => boolean,
	) {
		if (!current()) return;
		if (outcome.status === "authenticated") {
			codeForm.reset();
			setFeedback(null);
			await router.navigate({ href: redirect, replace: true });
		} else if (outcome.status === "two-factor-required") {
			setFactorDismissed(false);
			setUncertain(false);
			setMessage(null);
		} else if (outcome.status === "uncertain") {
			setUncertain(true);
			setMessage({ kind: "warning", text: m.signin_uncertain() });
		} else if (outcome.status === "rejected") {
			if (outcome.httpStatus === 429)
				setMessage({ kind: "warning", text: m.code_rate_limited() });
			else if (
				["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"].includes(
					outcome.code ?? "",
				)
			) {
				setCodeInvalid(true);
				setMessage({
					kind: "error",
					text:
						outcome.code === "TOO_MANY_ATTEMPTS"
							? m.code_attempts_exceeded()
							: m.code_invalid(),
				});
			} else
				setMessage({
					kind: "error",
					text: m.signin_is_unavailable_please_try_again(),
				});
		} else
			setMessage({
				kind: "error",
				text: m.signin_is_unavailable_please_try_again(),
			});
	}
	const completeConditional = useEffectEvent(presentAuthentication);
	useEffect(() => {
		const recovery = identity.recovery;
		if (!recovery) return;
		setUncertain(true);
		if (recovery.email) {
			setSentEmail(recovery.email);
			setPhase("code");
		}
		setMessage({ kind: "warning", text: m.signin_uncertain() });
	}, [identity.recovery]);
	useEffect(() => {
		if (
			!hydrated ||
			phase !== "email" ||
			identity.twoFactorPending ||
			(loaded.twoFactorPending && !factorDismissed)
		)
			return;
		if (
			authentication.getSnapshot().pending ||
			authentication.getSnapshot().recovery
		)
			return;
		const state = lifetime.current;
		const generation = state.generation;
		const controller = new AbortController();
		let lease: AuthenticationOperation | null = null;
		const attempt = {
			cancel: () => {
				controller.abort();
				lease?.cancel();
			},
		};
		conditional.current = attempt;
		const current = () =>
			state.mounted &&
			state.generation === generation &&
			!controller.signal.aborted;
		void preparePasskey(controller.signal, true)
			.then(async (result) => {
				if (result.status !== "ready" || !current() || operation.current)
					return;
				lease = authentication.begin("passkey");
				if (!lease) return;
				setMessage(null);
				const outcome = await lease.submit(async (signal) => {
					const verified = await authClient.passkey.verifyAuthentication({
						response: result.assertion,
						fetchOptions: { signal, retry: 0 },
					});
					return {
						ok: !verified.error,
						code:
							verified.error && "code" in verified.error
								? verified.error.code
								: undefined,
						httpStatus: verified.error?.status,
					};
				});
				await completeConditional(outcome, current);
			})
			.catch(() => {
				if (current() && lease)
					setMessage({
						kind: "error",
						text: m.signin_is_unavailable_please_try_again(),
					});
			})
			.finally(() => {
				lease?.finish();
				if (conditional.current === attempt) conditional.current = null;
			});
		return attempt.cancel;
	}, [
		hydrated,
		phase,
		authentication,
		identity.twoFactorPending,
		loaded.twoFactorPending,
		factorDismissed,
	]);

	function begin(kind: "send" | "resend") {
		if (!hydrated || operation.current || authentication.getSnapshot().pending)
			return null;
		conditional.current?.cancel();
		const state = lifetime.current;
		const generation = ++state.generation;
		const owner = Symbol(kind);
		const controller = new AbortController();
		operation.current = owner;
		setAction(kind);
		setMessage(null);
		const current = () =>
			state.mounted &&
			state.generation === generation &&
			operation.current === owner &&
			!controller.signal.aborted;
		const finish = () => {
			if (operation.current === owner) {
				operation.current = null;
				if (state.mounted) setAction(null);
			}
			if (request.current === attempt) request.current = null;
		};
		const attempt = {
			cancel: () => {
				controller.abort();
				finish();
			},
		};
		request.current = attempt;
		return { current, finish, signal: controller.signal };
	}
	function cooldown(seconds = 60) {
		const time = Date.now();
		setNow(time);
		setRetryAt((previous) => Math.max(previous, time + seconds * 1000));
	}
	async function requestCode(value: string, resend: boolean) {
		if (resend && remaining > 0) return;
		const lease = begin(resend ? "resend" : "send");
		if (!lease) return;
		const email = value.trim();
		cooldown();
		const showCode = (feedback: Message) => {
			authentication.clearRecovery();
			setSentEmail(email);
			codeForm.reset();
			setCodeInvalid(false);
			setUncertain(false);
			setPhase("code");
			setMessage(feedback);
		};
		try {
			const result = await authClient.emailOtp.sendVerificationOtp({
				email,
				type: "sign-in",
				fetchOptions: {
					signal: lease.signal,
					onError: ({ response }: { response: Response }) => {
						if (lease.current() && response.status === 429) {
							const time = Date.now();
							setNow(time);
							setRetryAt(
								time +
									(Number(response.headers.get("X-Retry-After")) || 60) * 1000,
							);
							setSendRateLimited(true);
						}
					},
				},
			});
			if (!lease.current()) return;
			if (!result.error) {
				setSendRateLimited(false);
				showCode({ kind: "success", text: resend ? m.code_requested() : "" });
			} else if (result.error.status === 429)
				setMessage({ kind: "warning", text: m.code_rate_limited() });
			else if (!result.error.status || result.error.status >= 500)
				showCode({ kind: "warning", text: m.code_request_uncertain() });
			else setMessage({ kind: "error", text: m.code_request_failed() });
		} catch {
			if (lease.current())
				showCode({ kind: "warning", text: m.code_request_uncertain() });
		} finally {
			lease.finish();
		}
	}
	async function verifyCode(code: string) {
		if (!uncertain && !/^\d{6}$/.test(code)) {
			setCodeInvalid(true);
			setMessage({ kind: "error", text: m.code_six_digits() });
			return;
		}
		if (!uncertain && verifyRemaining > 0) return;
		if (operation.current || authentication.getSnapshot().pending) return;
		conditional.current?.cancel();
		const state = lifetime.current;
		const generation = ++state.generation;
		const current = () => state.mounted && state.generation === generation;
		setCodeInvalid(false);
		setMessage(null);
		if (uncertain || authentication.getSnapshot().recovery) {
			const outcome = await authentication.recover();
			await presentAuthentication(outcome, current);
			if (current() && outcome.status === "uncertain")
				setMessage({ kind: "warning", text: m.signin_check_failed() });
			return;
		}
		const lease = authentication.begin("verify");
		if (!lease) return;
		const attempt = { cancel: lease.cancel };
		request.current = attempt;
		try {
			const outcome = await lease.submit(async (signal) => {
				const result = await authClient.signIn.emailOtp({
					email: sentEmail,
					otp: code,
					fetchOptions: {
						signal,
						retry: 0,
						onError: ({ response }: { response: Response }) => {
							if (current() && response.status === 429) {
								const time = Date.now();
								setNow(time);
								setVerifyRetryAt(
									time +
										(Number(response.headers.get("X-Retry-After")) || 60) *
											1000,
								);
							}
						},
					},
				});
				return {
					ok: !result.error,
					twoFactorRequired:
						!!result.data &&
						"twoFactorRedirect" in result.data &&
						result.data.twoFactorRedirect === true,
					code: result.error?.code,
					httpStatus: result.error?.status,
				};
			}, sentEmail);
			await presentAuthentication(outcome, current);
		} catch {
			if (current())
				setMessage({ kind: "warning", text: m.signin_uncertain() });
		} finally {
			lease.finish();
			if (request.current === attempt) request.current = null;
		}
	}
	async function signInWithPasskey() {
		if (
			!passkeysSupported ||
			operation.current ||
			authentication.getSnapshot().pending
		)
			return;
		conditional.current?.cancel();
		const state = lifetime.current;
		const generation = ++state.generation;
		const current = () => state.mounted && state.generation === generation;
		if (authentication.getSnapshot().recovery?.method === "passkey") {
			await presentAuthentication(await authentication.recover(), current);
			return;
		}
		const lease = authentication.begin("passkey");
		if (!lease) return;
		const attempt = { cancel: lease.cancel };
		request.current = attempt;
		setMessage(null);
		try {
			const prepared = await preparePasskey(lease.signal, false);
			if (!current()) return;
			if (prepared.status !== "ready") {
				setMessage({
					kind: "error",
					text: m.passkey_signin_was_not_completed_try_again_or(),
				});
				return;
			}
			const outcome = await lease.submit(async (signal) => {
				const result = await authClient.passkey.verifyAuthentication({
					response: prepared.assertion,
					fetchOptions: { signal, retry: 0 },
				});
				return {
					ok: !result.error,
					code:
						result.error && "code" in result.error
							? result.error.code
							: undefined,
					httpStatus: result.error?.status,
				};
			});
			await presentAuthentication(outcome, current);
		} catch {
			if (current())
				setMessage({
					kind: "error",
					text: m.signin_is_unavailable_please_try_again(),
				});
		} finally {
			lease.finish();
			if (request.current === attempt) request.current = null;
		}
	}
	function changeEmail() {
		if (operation.current || authentication.getSnapshot().pending) return;
		authentication.clearRecovery();
		setFactorDismissed(true);
		lifetime.current.generation++;
		codeForm.reset();
		setCodeInvalid(false);
		setUncertain(false);
		setMessage(null);
		setPhase("email");
	}
	async function verifySecondFactor(code: string, backup: boolean) {
		if (operation.current || authentication.getSnapshot().pending) return;
		conditional.current?.cancel();
		const state = lifetime.current;
		const generation = ++state.generation;
		const current = () => state.mounted && state.generation === generation;
		const lease = authentication.begin("two-factor");
		if (!lease) return;
		const attempt = { cancel: lease.cancel };
		request.current = attempt;
		try {
			const outcome = await lease.submit(async (signal) => {
				const result = backup
					? await authClient.twoFactor.verifyBackupCode({
							code,
							trustDevice: false,
							fetchOptions: { signal, retry: 0 },
						})
					: await authClient.twoFactor.verifyTotp({
							code,
							trustDevice: false,
							fetchOptions: { signal, retry: 0 },
						});
				return {
					ok: !result.error,
					code: result.error?.code,
					httpStatus: result.error?.status,
				};
			}, sentEmail || undefined);
			if (!current()) return;
			if (outcome.status === "rejected")
				return outcome.httpStatus === 429
					? m.code_rate_limited()
					: m.two_factor_invalid();
			await presentAuthentication(outcome, current);
		} catch {
			if (current()) return m.signin_uncertain();
		} finally {
			lease.finish();
			if (request.current === attempt) request.current = null;
		}
	}
	const pendingText =
		action === "passkey"
			? m.signing_in()
			: action === "verify"
				? m.verifying_code()
				: action === "check"
					? m.checking_signin()
					: m.sending_code();

	// Shown under the code field in the code step and above the passkey option otherwise.
	const feedback = (
		<FormFeedback
			key={phase}
			id="signin-feedback"
			message={message?.text ?? ""}
			kind={message?.kind ?? "success"}
			pending={busy}
			pendingMessage={pendingText}
			reserveLine={false}
		/>
	);
	if (
		!uncertain &&
		(identity.twoFactorPending || (loaded.twoFactorPending && !factorDismissed))
	)
		return (
			<TwoFactorSignIn onVerify={verifySecondFactor} onBack={changeEmail} />
		);
	return (
		<AuthCard
			title={phase === "email" ? m.sign_in() : m.check_your_email()}
			description={
				phase === "email"
					? m.use_a_passkey_or_get_a_secure_signin()
					: m.code_for_email({ email: sentEmail })
			}
		>
			{phase === "email" ? (
				<form
					method="post"
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void emailForm.handleSubmit();
					}}
				>
					<emailForm.AppField name="email">
						{(field) => (
							<field.TextField
								ref={emailInput}
								id="email"
								label={m.email_address()}
								type="email"
								autoComplete="username webauthn"
								required
								disabled={!hydrated}
								readOnly={busy}
								maxLength={254}
							/>
						)}
					</emailForm.AppField>
					<Button
						type="submit"
						disabled={!hydrated || busy || (sendRateLimited && remaining > 0)}
						pending={action === "send"}
						pendingLabel={m.sending_code()}
					>
						{sendRateLimited && remaining > 0
							? m.verify_code_in({ seconds: remaining })
							: m.send_code()}
					</Button>
				</form>
			) : (
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void codeForm.handleSubmit();
					}}
				>
					<codeForm.Field name="code">
						{(field) => {
							const invalid = codeInvalid;
							return (
								<Field data-invalid={invalid} className="items-center gap-2">
									<FieldLabel htmlFor="email-code" className="sr-only">
										{m.signin_code()}
									</FieldLabel>
									<div className="flex justify-center">
										<InputOTP
											ref={codeInput}
											id="email-code"
											name={field.name}
											value={field.state.value}
											onChange={(value) => {
												setCodeInvalid(false);
												setMessage((current) =>
													current?.kind === "error" ? null : current,
												);
												field.handleChange(value);
											}}
											onBlur={field.handleBlur}
											inputMode="numeric"
											autoComplete="one-time-code"
											pattern={REGEXP_ONLY_DIGITS}
											maxLength={6}
											required={!uncertain}
											readOnly={busy || uncertain}
											aria-invalid={invalid}
											aria-describedby="code-help signin-feedback"
											pasteTransformer={(value) => value.replace(/\D/g, "")}
											pushPasswordManagerStrategy="increase-width"
										>
											<InputOTPGroup aria-hidden="true">
												<InputOTPSlot index={0} aria-invalid={invalid} />
												<InputOTPSlot index={1} aria-invalid={invalid} />
												<InputOTPSlot index={2} aria-invalid={invalid} />
												<InputOTPSlot index={3} aria-invalid={invalid} />
												<InputOTPSlot index={4} aria-invalid={invalid} />
												<InputOTPSlot index={5} aria-invalid={invalid} />
											</InputOTPGroup>
										</InputOTP>
									</div>
									<FieldDescription
										id="code-help"
										className="text-center text-[13px]"
									>
										{m.code_expires_short()}
									</FieldDescription>
								</Field>
							);
						}}
					</codeForm.Field>
					{feedback}
					<ActionStack>
						<Button
							type="submit"
							disabled={busy || (!uncertain && verifyRemaining > 0)}
							pending={action === "verify" || action === "check"}
							pendingLabel={
								uncertain ? m.checking_signin() : m.verifying_code()
							}
						>
							{uncertain
								? m.check_signin()
								: verifyRemaining
									? m.verify_code_in({ seconds: verifyRemaining })
									: m.verify_code()}
						</Button>
						<div className="-mx-2 flex flex-wrap items-center justify-between gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								disabled={busy}
								onClick={changeEmail}
							>
								<ArrowLeftIcon aria-hidden="true" />
								{m.change_email()}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-muted-foreground disabled:opacity-100"
								disabled={busy || remaining > 0}
								pending={action === "resend"}
								pendingLabel={m.sending_code()}
								onClick={() => void requestCode(sentEmail, true)}
							>
								{remaining
									? m.resend_code_in({ seconds: remaining })
									: m.resend_code()}
							</Button>
						</div>
					</ActionStack>
				</form>
			)}
			{phase === "email" && feedback}
			{phase === "email" && (
				<div className="flex flex-col gap-4">
					<AuthDivider>{m.auth_or()}</AuthDivider>
					<Button
						type="button"
						variant="outline"
						disabled={busy || !passkeysSupported}
						pending={action === "passkey"}
						pendingLabel={m.signing_in()}
						onClick={() => void signInWithPasskey()}
					>
						<FingerprintPatternIcon aria-hidden="true" />
						{identity.recovery?.method === "passkey"
							? m.check_signin()
							: m.sign_in_with_a_passkey()}
					</Button>
					{passkeysSupported === false && (
						<p className="text-sm text-muted-foreground">
							{m.passkeys_require_a_supported_browser_and_https_or()}
						</p>
					)}
				</div>
			)}
		</AuthCard>
	);
}
