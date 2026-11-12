import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useHydrated, useRouter } from "@tanstack/react-router";
import {
	FingerprintPatternIcon,
	LogOutIcon,
	PencilIcon,
	Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { authClient } from "@/auth/client";
import { registerPasskey } from "@/auth/passkey";
import { useAccountPasskeys } from "@/auth/use-account-passkeys";
import { useAppForm } from "@/components/app-form";
import { FormFeedback } from "@/components/form-feedback";
import { useLocaleChangeBlocker } from "@/components/locale-safety";
import { useMutationFeedback } from "@/components/mutation-feedback";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { AlertDialogActions, DialogActions } from "../dialog-actions";
import { signOutOfApplication } from "../sign-out";
import { useStepUpAuthentication } from "../step-up-authentication";
import { TimeDisplay } from "../time-display";
import { useMutationOwner } from "../use-mutation-owner";
import { usePageConfirmation } from "../use-page-confirmation";
import { ProfileDetails } from "./profile-details";
import { SettingsPageHeading } from "./settings-page-heading";
import { SettingsSection } from "./settings-section";
import { TwoFactorSettings } from "./two-factor-settings";
import { WebSessions } from "./web-sessions";

export function UserProfile() {
	const { user } = getRouteApi("/_app").useRouteContext();
	const requireStepUp = useStepUpAuthentication();
	const router = useRouter();
	const hydrated = useHydrated();
	const queryClient = useQueryClient();
	const { begin } = useMutationOwner(user.id);
	const setFeedback = useMutationFeedback();
	const { passkeys, identity } = useAccountPasskeys();
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [activity, setActivity] = useState<
		"add" | "remove" | "rename" | "sessions" | "signout" | null
	>(null);
	const actionBusy = useRef(false);
	const [actionPending, setPending] = useState(false);
	const form = useAppForm({
		defaultValues: { name: "" },
		onSubmit: async ({ value }) => {
			if (!hydrated || actionPending) return;
			await runAction((signal) =>
				registerPasskey(signal, user.id, value.name.trim() || undefined),
			);
		},
	});
	const addingPasskey = useSelector(form.store, (state) => state.isSubmitting);
	const signingOut = identity.action === "signout";
	const pending = actionPending || addingPasskey || signingOut;
	const visibleActivity = signingOut ? "signout" : activity;
	useLocaleChangeBlocker(pending);
	const [deleteId, setDeleteId] = usePageConfirmation<string>();
	const heading = useRef<HTMLHeadingElement>(null);
	const completedDeletion = useRef<string | null>(null);
	const [renameId, setRenameId] = usePageConfirmation<string>();
	const [renameName, setRenameName] = useState("");
	const renameTrigger = useRef<HTMLButtonElement | null>(null);

	async function runAction(
		action: (signal: AbortSignal) => Promise<{
			error: { code?: string; message?: string } | null;
		}>,
		removedId?: string,
		kind: "add" | "remove" | "rename" | "sessions" = "add",
	) {
		if (actionBusy.current) return;
		if (!(await requireStepUp({ userId: user.id, email: user.email }))) return;
		const operation = begin(() => {
			actionBusy.current = false;
			setPending(false);
			setActivity(null);
			setMessage("");
			setFailed(false);
			setRenameName("");
			completedDeletion.current = null;
		});
		if (!operation) return;
		actionBusy.current = true;
		setActivity(kind);
		setPending(true);
		setMessage("");
		setFailed(false);
		try {
			const result = await action(operation.signal);
			if (!operation.current()) return;
			if (result.error) {
				setFailed(true);
				setMessage(
					result.error.code === "SESSION_NOT_FRESH"
						? m.error_session_fresh()
						: m.the_action_was_not_completed_please_try_again(),
				);
			} else {
				completedDeletion.current = removedId ?? null;
				setMessage(m.account_security_updated());
				setDeleteId(null);
				setRenameId(null);
				if (kind === "sessions")
					await queryClient.invalidateQueries({
						queryKey: ["account-web-sessions", user.id],
					});
				else await passkeys.refetch();
			}
		} catch {
			if (!operation.current()) return;
			setFailed(true);
			setMessage(m.the_action_was_not_completed_please_try_again());
		} finally {
			if (operation.current()) {
				actionBusy.current = false;
				setPending(false);
			}
			operation.finish();
		}
	}

	async function signOut() {
		if (actionBusy.current) return;
		setMessage("");
		setFailed(false);
		const failure = await signOutOfApplication(router, setFeedback);
		if (failure) {
			setActivity("signout");
			setFailed(true);
			setMessage(failure);
		}
	}

	const passkeyList = () => {
		if (identity.pending || passkeys.isPending || passkeys.isFetching)
			return (
				<div>
					<p role="status">{m.loading_passkeys()}</p>
					<Skeleton aria-hidden="true" className="mt-2 h-12 w-full" />
				</div>
			);
		if (passkeys.error)
			return (
				<p role="alert">
					{m.could_not_load_passkeys_try_refreshing_the_page()}
				</p>
			);
		if (passkeys.data?.length)
			return (
				<Card className="gap-0 border py-0 ring-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{m.name()}</TableHead>
								<TableHead>{m.passkey_type()}</TableHead>
								<TableHead>{m.created()}</TableHead>
								<TableHead>
									<span className="sr-only">{m.actions()}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{passkeys.data.map((key) => (
								<TableRow key={key.id}>
									<TableCell>{key.name || m.passkey()}</TableCell>
									<TableCell>
										{key.deviceType === "multiDevice"
											? m.passkey_synced()
											: m.passkey_device_bound()}
									</TableCell>
									<TableCell className="whitespace-nowrap">
										{key.createdAt ? (
											<TimeDisplay value={key.createdAt} mode="compact" />
										) : (
											"—"
										)}
									</TableCell>
									<TableCell>
										<div className="flex justify-end gap-2">
											<Button
												variant="ghost"
												size="icon"
												aria-label={m.rename()}
												title={m.rename()}
												disabled={!hydrated || pending}
												onClick={(event) => {
													renameTrigger.current = event.currentTarget;
													setRenameId(key.id);
													setRenameName(key.name || "");
													setMessage("");
												}}
											>
												<PencilIcon aria-hidden="true" />
											</Button>
											<AlertDialog
												open={deleteId === key.id}
												onOpenChange={(open) => {
													if (!pending) {
														if (open) completedDeletion.current = null;
														setMessage("");
														setDeleteId(open ? key.id : null);
													}
												}}
											>
												<AlertDialogTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														aria-label={m.remove()}
														title={m.remove()}
														className="text-destructive"
														disabled={!hydrated || pending}
													>
														<Trash2Icon aria-hidden="true" />
													</Button>
												</AlertDialogTrigger>
												<AlertDialogContent
													onEscapeKeyDown={(event) => {
														if (pending) event.preventDefault();
													}}
													onCloseAutoFocus={(event) => {
														if (
															completedDeletion.current === key.id ||
															pending
														) {
															event.preventDefault();
															heading.current?.focus();
														}
													}}
												>
													<AlertDialogTitle>
														{m.confirm_removal()}
													</AlertDialogTitle>
													<AlertDialogDescription>
														{key.name || m.passkey()}
													</AlertDialogDescription>
													<FormFeedback
														message={failed ? message : ""}
														kind="error"
														pending={pending}
														pendingMessage={m.removing_passkey()}
													/>
													<AlertDialogActions
														cancel={{
															label: m.cancel(),
															disabled: !hydrated || pending,
															onClick: () => setDeleteId(null),
														}}
													>
														<Button
															variant="destructive"
															disabled={!hydrated || pending}
															pending={pending && activity === "remove"}
															pendingLabel={m.removing_passkey()}
															onClick={() =>
																runAction(
																	(signal) =>
																		authClient.passkey.deletePasskey({
																			id: key.id,
																			fetchOptions: { signal },
																		}),
																	key.id,
																	"remove",
																)
															}
														>
															{m.confirm_removal()}
														</Button>
													</AlertDialogActions>
												</AlertDialogContent>
											</AlertDialog>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Card>
			);
		return <p className="text-sm">{m.no_passkeys_registered_yet()}</p>;
	};
	return (
		<div className="relative flex min-w-0 flex-col gap-8">
			<SettingsPageHeading
				headingRef={heading}
				actions={
					<Button
						variant="outline"
						onClick={signOut}
						disabled={!hydrated || pending}
						pending={signingOut}
						pendingLabel={m.signing_out()}
					>
						<LogOutIcon aria-hidden="true" />
						{m.sign_out()}
					</Button>
				}
			/>
			<FormFeedback
				message={visibleActivity === "signout" ? message : ""}
				kind={failed ? "error" : "success"}
				pending={signingOut}
				pendingMessage={m.signing_out()}
				reserveLine={false}
			/>
			<ProfileDetails />
			<TwoFactorSettings />
			<SettingsSection
				id="passkeys"
				title={m.passkeys()}
				description={m.passkey_recovery_help()}
			>
				<form
					method="post"
					className="flex max-w-2xl flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void form.handleSubmit();
					}}
				>
					<div className="min-w-48 flex-1">
						<form.AppField name="name">
							{(field) => (
								<field.TextField
									id="passkey-name"
									label={m.passkey_name()}
									maxLength={100}
									disabled={!hydrated || pending}
									placeholder={m.for_example_personal_laptop()}
								/>
							)}
						</form.AppField>
					</div>
					<Button
						type="submit"
						disabled={!hydrated || pending}
						pending={addingPasskey}
						pendingLabel={m.adding_passkey()}
					>
						<FingerprintPatternIcon aria-hidden="true" />
						{m.add_a_passkey()}
					</Button>
				</form>
				{passkeyList()}
				<FormFeedback
					message={
						(activity === "add" || activity === "remove") && !deleteId
							? message
							: ""
					}
					kind={failed ? "error" : "success"}
					pending={addingPasskey}
					pendingMessage={m.adding_passkey()}
					reserveLine={false}
				/>
			</SettingsSection>
			<SettingsSection
				id="login-sessions"
				title={m.web_sessions()}
				description={m.web_sessions_description()}
			>
				<Button
					variant="outline"
					className="self-start"
					disabled={!hydrated || pending}
					pending={pending && activity === "sessions"}
					pendingLabel={m.revoking_sessions()}
					onClick={() =>
						runAction(
							(signal) =>
								authClient.revokeOtherSessions({ fetchOptions: { signal } }),
							undefined,
							"sessions",
						)
					}
				>
					<LogOutIcon aria-hidden="true" />
					{m.sign_out_other_sessions()}
				</Button>
				<FormFeedback
					message={activity === "sessions" ? message : ""}
					kind={failed ? "error" : "success"}
					pending={pending && activity === "sessions"}
					pendingMessage={m.revoking_sessions()}
					reserveLine={false}
				/>
				<WebSessions />
			</SettingsSection>
			<Dialog
				open={!!renameId}
				onOpenChange={(open) => {
					if (!pending && !open) setRenameId(null);
				}}
			>
				<DialogContent
					aria-describedby={undefined}
					onEscapeKeyDown={(event) => {
						if (pending) event.preventDefault();
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						(renameTrigger.current?.isConnected
							? renameTrigger.current
							: heading.current
						)?.focus();
					}}
				>
					<DialogHeader className="border-b pb-4 pr-8">
						<DialogTitle>{m.rename_passkey()}</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							if (renameId && renameName.trim() && !pending)
								void runAction(
									(signal) =>
										authClient.passkey.updatePasskey({
											id: renameId,
											name: renameName.trim(),
											fetchOptions: { signal },
										}),
									undefined,
									"rename",
								);
						}}
						className="flex flex-col gap-4"
					>
						<Label className="sr-only" htmlFor="rename-passkey-name">
							{m.passkey_name()}
						</Label>
						<Input
							id="rename-passkey-name"
							required
							maxLength={100}
							value={renameName}
							disabled={pending}
							onChange={(event) => setRenameName(event.target.value)}
						/>
						<FormFeedback
							message={activity === "rename" ? message : ""}
							kind={failed ? "error" : "success"}
							pending={pending}
							reserveLine={false}
						/>
						<DialogActions
							cancel={{
								label: m.cancel(),
								disabled: pending,
								onClick: () => setRenameId(null),
							}}
						>
							<Button
								type="submit"
								disabled={pending || !renameName.trim()}
								pending={pending && activity === "rename"}
							>
								{m.save_setting()}
							</Button>
						</DialogActions>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
