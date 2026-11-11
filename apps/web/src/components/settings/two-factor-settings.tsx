import { m } from "@recount/i18n/messages";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import {
	CheckIcon,
	CircleCheckIcon,
	CopyIcon,
	ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accountContextHeader } from "../../auth/account-context";
import { authClient } from "../../auth/client";
import { broadcastBetterAuthIdentity } from "../../auth/identity-state";
import { AlertDialogActions } from "../dialog-actions";
import { FormFeedback } from "../form-feedback";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useMutationFeedback } from "../mutation-feedback";
import { useStepUpAuthentication } from "../step-up-authentication";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useMutationOwner } from "../use-mutation-owner";
import { usePageConfirmation } from "../use-page-confirmation";
import { SettingsSection } from "./settings-section";

type Copied = "copied" | "failed" | null;

export function TwoFactorSettings() {
	const { user } = getRouteApi("/_app").useRouteContext();
	const requireStepUp = useStepUpAuthentication();
	const hydrated = useHydrated();
	const { begin, router } = useMutationOwner(user.id);
	const session = authClient.useSession();
	const accountMatches =
		!session.isPending &&
		!session.isRefetching &&
		!session.error &&
		session.data?.user.id === user.id;
	const liveIdentity = useRef<string | null>(null);
	liveIdentity.current = session.error ? null : (session.data?.user.id ?? null);
	const secretEpoch = useRef(0);
	const setFeedback = useMutationFeedback();
	const [setup, setSetup] = useState<{
		secret: string;
		qr?: string;
	} | null>(null);
	// Open while the recovery codes dialog is shown; codes are held only until it closes.
	const [recovery, setRecovery] = useState<{ codes: string[] | null } | null>(
		null,
	);
	const [copied, setCopied] = useState<Copied>(null);
	const [keyCopied, setKeyCopied] = useState<Copied>(null);
	const codeInput = useRef<HTMLInputElement>(null);
	const [code, setCode] = useState("");
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [confirm, setConfirm] = usePageConfirmation<"disable">();
	const busy = useRef(false);
	useLocaleChangeBlocker(pending);
	useEffect(() => {
		if (
			session.isPending ||
			(!session.error && session.data?.user.id === user.id)
		)
			return;
		setSetup(null);
		setRecovery(null);
		secretEpoch.current++;
		setCode("");
		setConfirm(null);
		if (!session.error) void router.invalidate({ sync: true }).catch(() => {});
	}, [
		session.isPending,
		session.error,
		session.data?.user.id,
		user.id,
		router,
		setConfirm,
	]);
	async function run<T>(
		action: (
			signal: AbortSignal,
		) => Promise<{ data: T | null; error: { code?: string } | null }>,
		complete: (data: T, current: () => boolean) => void | Promise<void>,
		refresh = false,
		rejected?: (code: string | undefined) => string | undefined,
	) {
		if (busy.current || !accountMatches) return;
		if (!(await requireStepUp({ userId: user.id, email: user.email }))) return;
		const operation = begin(() => {
			busy.current = false;
			setPending(false);
			setSetup(null);
			setRecovery(null);
			setCode("");
			setConfirm(null);
		});
		if (!operation) return;
		const epoch = secretEpoch.current;
		const current = () =>
			operation.current() &&
			secretEpoch.current === epoch &&
			(liveIdentity.current === null || liveIdentity.current === user.id);
		busy.current = true;
		setPending(true);
		setMessage("");
		try {
			const result = await action(operation.signal);
			if (!current()) return;
			if (result.error || !result.data) {
				if (result.error?.code === "ACCOUNT_CHANGED") {
					setSetup(null);
					setRecovery(null);
					setCode("");
					setConfirm(null);
					await router.invalidate({ sync: true }).catch(() => {});
					return;
				}
				setMessage(
					result.error?.code === "SESSION_NOT_FRESH"
						? m.error_session_fresh()
						: (rejected?.(result.error?.code) ??
								m.the_action_was_not_completed_please_try_again()),
				);
				return;
			}
			broadcastBetterAuthIdentity();
			const confirmed = await authClient.getSession({
				fetchOptions: { signal: operation.signal, timeout: 10_000 },
			});
			if (!current()) return;
			if (confirmed.error || confirmed.data?.user.id !== user.id) {
				setSetup(null);
				setRecovery(null);
				setCode("");
				await router.invalidate({ sync: true }).catch(() => {});
				return;
			}
			await complete(result.data, current);
			if (refresh)
				await operation.refresh(
					m.account_security_updated(),
					m.your_change_was_saved_but_the_page_could_2(),
				);
		} catch {
			if (current()) setMessage(m.the_response_was_lost_the_action_may_have());
		} finally {
			if (operation.current()) {
				busy.current = false;
				setPending(false);
			}
			operation.finish();
		}
	}
	function securityFetchOptions(signal: AbortSignal) {
		return { signal, headers: { [accountContextHeader]: user.id } };
	}
	async function copy(value: string, done: (state: Copied) => void) {
		try {
			await navigator.clipboard.writeText(value);
			done("copied");
		} catch {
			done("failed");
		}
	}
	function closeSetup() {
		setSetup(null);
		setKeyCopied(null);
		setCode("");
		setMessage("");
	}
	function closeRecovery() {
		setRecovery(null);
		setCopied(null);
		setMessage("");
	}
	function startSetup() {
		void run(
			(signal) =>
				authClient.twoFactor.enable({
					method: "totp",
					fetchOptions: securityFetchOptions(signal),
				}),
			async (data, current) => {
				if (!("totpURI" in data)) return;
				const uri = data.totpURI;
				let qr: string | undefined;
				try {
					qr = await (await import("qrcode")).toDataURL(uri, {
						width: 240,
						margin: 2,
					});
				} catch {
					/* The setup key remains available if QR rendering is unavailable. */
				}
				if (!current()) return;
				setKeyCopied(null);
				setSetup({ secret: new URL(uri).searchParams.get("secret") ?? "", qr });
			},
		);
	}
	function verifySetup() {
		if (!/^\d{6}$/.test(code)) {
			setMessage(m.code_six_digits());
			codeInput.current?.focus();
			return;
		}
		void run(
			(signal) =>
				authClient.twoFactor.verifyTotp({
					code,
					trustDevice: false,
					fetchOptions: securityFetchOptions(signal),
				}),
			() => closeSetup(),
			true,
			(errorCode) => {
				if (errorCode !== "INVALID_CODE") return undefined;
				setCode("");
				requestAnimationFrame(() => codeInput.current?.focus());
				return m.two_factor_setup_invalid();
			},
		);
	}
	function generateRecoveryCodes() {
		void run(
			(signal) =>
				authClient.twoFactor.generateBackupCodes({
					fetchOptions: securityFetchOptions(signal),
				}),
			(data) => {
				setCopied(null);
				setRecovery({ codes: data.backupCodes });
				setFeedback(m.two_factor_recovery_generated(), "success");
			},
		);
	}
	const visibleSetup = accountMatches ? setup : null;
	const visibleRecovery = accountMatches ? recovery : null;
	const dialogHeader = "-mx-4 border-b px-4 pb-3";
	return (
		<SettingsSection
			id="two-factor-authentication"
			title={m.settings_two_factor()}
			description={m.two_factor_description()}
		>
			{user.twoFactorEnabled ? (
				<>
					<p className="flex items-center gap-2 font-medium">
						<CircleCheckIcon
							aria-hidden="true"
							className="size-4 text-primary"
						/>
						{m.two_factor_enabled()}
					</p>
					<div className="flex max-w-2xl flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-col gap-1">
							<p className="font-medium">{m.two_factor_app_title()}</p>
							<p className="text-sm text-muted-foreground">
								{m.two_factor_app_enabled()}
							</p>
						</div>
						<div className="flex shrink-0 gap-2">
							<Button
								variant="outline"
								disabled={!hydrated || !accountMatches || pending}
								onClick={() => {
									setMessage("");
									setRecovery({ codes: null });
								}}
							>
								{m.two_factor_recovery_title()}
							</Button>
							<Button
								variant="destructive"
								disabled={!hydrated || !accountMatches || pending}
								onClick={() => {
									setMessage("");
									setConfirm("disable");
								}}
							>
								{m.two_factor_disable()}
							</Button>
						</div>
					</div>
				</>
			) : (
				<>
					<p className="text-sm text-muted-foreground">
						{m.two_factor_disabled()}
					</p>
					<div>
						<Button
							disabled={!hydrated || !accountMatches || pending}
							onClick={startSetup}
						>
							<ShieldCheckIcon aria-hidden="true" />
							{m.two_factor_setup()}
						</Button>
					</div>
				</>
			)}
			<FormFeedback
				message={setup || recovery || confirm ? "" : message}
				kind="error"
				pending={pending}
				reserveLine={false}
			/>
			<Dialog
				open={!!visibleSetup}
				onOpenChange={(open) => {
					if (!open && !pending) closeSetup();
				}}
			>
				<DialogContent
					className="sm:max-w-lg"
					showCloseButton={!pending}
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
					onInteractOutside={(event) => event.preventDefault()}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						codeInput.current?.focus();
					}}
				>
					{visibleSetup && (
						<form
							method="post"
							className="flex flex-col gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								verifySetup();
							}}
						>
							<DialogHeader className={dialogHeader}>
								<DialogTitle>{m.two_factor_setup()}</DialogTitle>
							</DialogHeader>
							<DialogDescription className="text-foreground">
								{m.two_factor_scan()}
							</DialogDescription>
							{visibleSetup.qr && (
								<img
									src={visibleSetup.qr}
									width={200}
									height={200}
									alt={m.two_factor_qr_alt()}
									className="mx-auto my-2 size-50 rounded-sm bg-white"
								/>
							)}
							<div className="flex flex-col items-center gap-2 text-center">
								<p className="text-muted-foreground">{m.two_factor_manual()}</p>
								<div className="flex max-w-full items-center gap-1">
									<code className="min-w-0 break-all font-mono text-sm select-all">
										{visibleSetup.secret}
									</code>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={m.settings_copy()}
										onClick={() => void copy(visibleSetup.secret, setKeyCopied)}
									>
										{keyCopied === "copied" ? (
											<CheckIcon aria-hidden="true" />
										) : (
											<CopyIcon aria-hidden="true" />
										)}
									</Button>
								</div>
								<CopyStatus state={keyCopied} />
							</div>
							<div className="mt-2 flex flex-col gap-2">
								<Label htmlFor="setup-totp-code">
									{m.two_factor_authenticator_code()}
								</Label>
								<Input
									ref={codeInput}
									id="setup-totp-code"
									value={code}
									onChange={(event) => {
										setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
										setMessage("");
									}}
									placeholder="123456"
									autoComplete="one-time-code"
									inputMode="numeric"
									pattern="[0-9]{6}"
									maxLength={6}
									readOnly={pending}
									aria-invalid={!!message}
									aria-describedby="setup-totp-feedback"
								/>
							</div>
							<Button
								type="submit"
								className="w-full"
								disabled={pending}
								pending={pending}
								pendingLabel={m.verifying_code()}
							>
								{m.two_factor_enable()}
							</Button>
							<FormFeedback
								id="setup-totp-feedback"
								message={message}
								kind="error"
								reserveLine={false}
							/>
						</form>
					)}
				</DialogContent>
			</Dialog>
			<Dialog
				open={!!visibleRecovery}
				onOpenChange={(open) => {
					if (!open && !pending) closeRecovery();
				}}
			>
				<DialogContent
					className="sm:max-w-md"
					showCloseButton={!pending}
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
					onInteractOutside={(event) => event.preventDefault()}
				>
					<DialogHeader className={dialogHeader}>
						<DialogTitle>{m.two_factor_recovery_title()}</DialogTitle>
					</DialogHeader>
					<DialogDescription className="text-foreground">
						{visibleRecovery?.codes
							? m.two_factor_recovery_save()
							: m.two_factor_recovery_intro()}
					</DialogDescription>
					{visibleRecovery?.codes && (
						<div className="flex items-start justify-between gap-4 rounded-md bg-muted px-4 py-3">
							<ul className="flex flex-col gap-1 font-mono text-sm select-all">
								{visibleRecovery.codes.map((value) => (
									<li key={value}>{value}</li>
								))}
							</ul>
							<div className="flex flex-col items-end gap-1">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() =>
										void copy(
											visibleRecovery.codes?.join("\n") ?? "",
											setCopied,
										)
									}
								>
									{copied === "copied" ? (
										<CheckIcon aria-hidden="true" />
									) : (
										<CopyIcon aria-hidden="true" />
									)}
									{copied === "copied"
										? m.settings_copied()
										: m.two_factor_copy()}
								</Button>
								<CopyStatus state={copied} />
							</div>
						</div>
					)}
					<div>
						<Button
							variant="outline"
							disabled={pending}
							pending={pending}
							pendingLabel={m.saving()}
							onClick={generateRecoveryCodes}
						>
							{visibleRecovery?.codes
								? m.two_factor_regenerate()
								: m.two_factor_recovery_generate()}
						</Button>
					</div>
					<FormFeedback message={message} kind="error" reserveLine={false} />
				</DialogContent>
			</Dialog>
			<AlertDialog
				open={!!confirm && accountMatches}
				onOpenChange={(open) => {
					if (!open && !pending) setConfirm(null);
				}}
			>
				<AlertDialogContent
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
				>
					<AlertDialogTitle>{m.two_factor_disable_title()}</AlertDialogTitle>
					<AlertDialogDescription>
						{m.two_factor_disable_confirm()}
					</AlertDialogDescription>
					<FormFeedback message={message} kind="error" reserveLine={false} />
					<AlertDialogActions cancel={{ label: m.cancel(), disabled: pending }}>
						<Button
							variant="destructive"
							disabled={pending}
							pending={pending}
							pendingLabel={m.saving()}
							onClick={() =>
								void run(
									(signal) =>
										authClient.twoFactor.disable({
											fetchOptions: securityFetchOptions(signal),
										}),
									() => setConfirm(null),
									true,
								)
							}
						>
							{m.two_factor_disable()}
						</Button>
					</AlertDialogActions>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}

function CopyStatus({ state }: { state: Copied }) {
	return (
		<p
			role="status"
			className={state === "failed" ? "text-xs text-destructive" : "sr-only"}
		>
			{state === "failed"
				? m.settings_copy_failed()
				: state === "copied"
					? m.settings_copied()
					: ""}
		</p>
	);
}
