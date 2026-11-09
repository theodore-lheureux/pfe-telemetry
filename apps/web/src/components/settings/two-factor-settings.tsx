import { m } from "@recount/i18n/messages";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { DownloadIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accountContextHeader } from "../../auth/account-context";
import { authClient } from "../../auth/client";
import { broadcastBetterAuthIdentity } from "../../auth/identity-state";
import { FormFeedback } from "../form-feedback";
import { useLocaleChangeBlocker } from "../locale-safety";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { SettingsSection } from "./settings-section";

export function TwoFactorSettings() {
	const { user } = getRouteApi("/_app").useRouteContext();
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
	const [setup, setSetup] = useState<{
		uri?: string;
		qr?: string;
		codes: string[];
	} | null>(null);
	const [saved, setSaved] = useState(false);
	const [code, setCode] = useState("");
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [confirm, setConfirm] = useState<"disable" | "regenerate" | null>(null);
	const busy = useRef(false);
	useLocaleChangeBlocker(pending);
	useEffect(
		() =>
			getGlobalBroadcastChannel().subscribe(() => {
				secretEpoch.current++;
				setSetup(null);
				setCode("");
				setSaved(false);
				setConfirm(null);
			}),
		[],
	);
	useEffect(() => {
		if (
			session.isPending ||
			(!session.error && session.data?.user.id === user.id)
		)
			return;
		setSetup(null);
		secretEpoch.current++;
		setCode("");
		setSaved(false);
		setConfirm(null);
		if (!session.error) void router.invalidate({ sync: true }).catch(() => {});
	}, [
		session.isPending,
		session.error,
		session.data?.user.id,
		user.id,
		router,
	]);
	useEffect(() => {
		const clear = () => {
			setSetup(null);
			setCode("");
			setSaved(false);
		};
		window.addEventListener("pagehide", clear);
		return () => window.removeEventListener("pagehide", clear);
	}, []);
	async function run<T>(
		action: (
			signal: AbortSignal,
		) => Promise<{ data: T | null; error: { code?: string } | null }>,
		complete: (data: T, current: () => boolean) => void | Promise<void>,
		refresh = false,
	) {
		if (busy.current || !accountMatches) return;
		const operation = begin(() => {
			busy.current = false;
			setPending(false);
			setSetup(null);
			setCode("");
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
					setCode("");
					setConfirm(null);
					await router.invalidate({ sync: true }).catch(() => {});
					return;
				}
				setMessage(
					result.error?.code === "SESSION_NOT_FRESH"
						? m.error_session_fresh()
						: m.the_action_was_not_completed_please_try_again(),
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
	function download() {
		if (!setup || !accountMatches) return;
		const url = URL.createObjectURL(
			new Blob([`Recount\n\n${setup.codes.join("\n")}\n`], {
				type: "text/plain;charset=utf-8",
			}),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "recount-recovery-codes.txt";
		link.click();
		URL.revokeObjectURL(url);
	}
	const visibleSetup = accountMatches ? setup : null;
	return (
		<SettingsSection
			id="two-factor-authentication"
			title={m.settings_two_factor()}
			description={m.two_factor_description()}
		>
			<div>
				<Badge variant="outline">
					{user.twoFactorEnabled
						? m.two_factor_enabled()
						: m.two_factor_disabled()}
				</Badge>
			</div>
			<div className="flex flex-wrap gap-2">
				{!user.twoFactorEnabled ? (
					<Button
						disabled={!hydrated || !accountMatches || pending}
						onClick={() =>
							void run(
								(signal) =>
									authClient.twoFactor.enable({
										method: "totp",
										fetchOptions: securityFetchOptions(signal),
									}),
								async (data, current) => {
									if (!("totpURI" in data) || !("backupCodes" in data)) return;
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
									setSaved(false);
									setSetup({ uri, qr, codes: data.backupCodes });
								},
							)
						}
					>
						<ShieldCheckIcon aria-hidden="true" />
						{m.two_factor_setup()}
					</Button>
				) : (
					<>
						<Button
							variant="outline"
							disabled={!hydrated || !accountMatches || pending}
							onClick={() => setConfirm("regenerate")}
						>
							{m.two_factor_regenerate()}
						</Button>
						<Button
							variant="outline"
							disabled={!hydrated || !accountMatches || pending}
							onClick={() => setConfirm("disable")}
						>
							{m.two_factor_disable()}
						</Button>
					</>
				)}
			</div>
			<FormFeedback
				message={setup || confirm ? "" : message}
				kind="error"
				pending={pending}
				reserveLine={false}
			/>
			<Dialog
				open={!!visibleSetup}
				onOpenChange={(open) => {
					if (!open && !pending) {
						setSetup(null);
						setCode("");
						setSaved(false);
					}
				}}
			>
				<DialogContent
					className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
					showCloseButton={!pending}
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
					onInteractOutside={(event) => {
						if (pending) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{visibleSetup?.uri
								? m.two_factor_setup()
								: m.two_factor_recovery_title()}
						</DialogTitle>
						<DialogDescription>
							{visibleSetup?.uri
								? m.two_factor_scan()
								: m.two_factor_recovery_help()}
						</DialogDescription>
					</DialogHeader>
					{visibleSetup?.uri && (
						<>
							{visibleSetup.qr && (
								<img
									src={visibleSetup.qr}
									width={240}
									height={240}
									alt={m.two_factor_qr_alt()}
									className="mx-auto rounded-md bg-white"
								/>
							)}
							<p className="text-sm font-medium">{m.two_factor_setup_key()}</p>
							<code className="break-all rounded-md border p-2 text-sm select-all">
								{new URL(visibleSetup.uri).searchParams.get("secret")}
							</code>
						</>
					)}
					<div className="flex flex-col gap-2">
						<h3 className="font-semibold">{m.two_factor_recovery_title()}</h3>
						<p className="text-sm text-muted-foreground">
							{m.two_factor_recovery_help()}
						</p>
						<pre className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm select-all">
							{visibleSetup?.codes.map((value) => (
								<code key={value}>{value}</code>
							))}
						</pre>
						<Button variant="outline" onClick={download}>
							<DownloadIcon aria-hidden="true" />
							{m.two_factor_download()}
						</Button>
					</div>
					{visibleSetup?.uri && (
						<form
							method="post"
							className="flex flex-col gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								if (saved)
									void run(
										(signal) =>
											authClient.twoFactor.verifyTotp({
												code,
												trustDevice: false,
												fetchOptions: securityFetchOptions(signal),
											}),
										() => {
											setSetup(null);
											setCode("");
										},
										true,
									);
							}}
						>
							<div className="flex items-center gap-2">
								<Checkbox
									id="saved-recovery-codes"
									checked={saved}
									onCheckedChange={(value) => setSaved(value === true)}
									disabled={pending}
								/>
								<Label htmlFor="saved-recovery-codes">
									{m.two_factor_saved_codes()}
								</Label>
							</div>
							<Label htmlFor="setup-totp-code">
								{m.two_factor_authenticator_code()}
							</Label>
							<Input
								id="setup-totp-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
								autoComplete="one-time-code"
								inputMode="numeric"
								pattern="[0-9]{6}"
								required
								maxLength={6}
								disabled={pending}
							/>
							<Button
								type="submit"
								disabled={pending || !saved}
								pending={pending}
								pendingLabel={m.verifying_code()}
							>
								{m.two_factor_enable()}
							</Button>
							<FormFeedback
								message={message}
								kind="error"
								reserveLine={false}
							/>
						</form>
					)}
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
					<AlertDialogTitle>
						{confirm === "disable"
							? m.two_factor_disable()
							: m.two_factor_regenerate()}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{confirm === "disable"
							? m.two_factor_disable_help()
							: m.two_factor_regenerate_help()}
					</AlertDialogDescription>
					<FormFeedback message={message} kind="error" reserveLine={false} />
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>
							{m.cancel()}
						</AlertDialogCancel>
						<Button
							disabled={pending}
							pending={pending}
							pendingLabel={m.saving()}
							onClick={() => {
								if (confirm === "disable")
									void run(
										(signal) =>
											authClient.twoFactor.disable({
												fetchOptions: securityFetchOptions(signal),
											}),
										() => setConfirm(null),
										true,
									);
								else
									void run(
										(signal) =>
											authClient.twoFactor.generateBackupCodes({
												fetchOptions: securityFetchOptions(signal),
											}),
										(data) => {
											setConfirm(null);
											setSetup({ codes: data.backupCodes });
										},
									);
							}}
						>
							{confirm === "disable"
								? m.two_factor_disable()
								: m.two_factor_regenerate()}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}
