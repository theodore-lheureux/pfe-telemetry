import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useHydrated, useRouter } from "@tanstack/react-router";
import { LogOutIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { authClient } from "@/auth/client";
import { useAccountPasskeys } from "@/auth/use-account-passkeys";
import { useAppForm } from "@/components/app-form";
import { FormFeedback } from "@/components/form-feedback";
import { useLocaleChangeBlocker } from "@/components/locale-safety";
import { useMutationFeedback } from "@/components/mutation-feedback";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
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
import { signOutOfApplication } from "../sign-out";
import { ProfileDetails } from "./profile-details";
import { SessionTime } from "./session-time";
import { SettingsSection } from "./settings-section";
import { WebSessions } from "./web-sessions";

export function UserProfile() {
	const { user } = getRouteApi("/_app").useRouteContext();
	const router = useRouter();
	const hydrated = useHydrated();
	const queryClient = useQueryClient();
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
			await runAction(() =>
				authClient.passkey.addPasskey({ name: value.name.trim() || undefined }),
			);
		},
	});
	const addingPasskey = useSelector(form.store, (state) => state.isSubmitting);
	const pending = actionPending || addingPasskey;
	useLocaleChangeBlocker(pending);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const completedDeletion = useRef<string | null>(null);
	const [renameId, setRenameId] = useState<string | null>(null);
	const [renameName, setRenameName] = useState("");
	const renameTrigger = useRef<HTMLButtonElement | null>(null);

	async function runAction(
		action: () => Promise<{
			error: { code?: string; message?: string } | null;
		}>,
		removedId?: string,
		kind: "add" | "remove" | "rename" | "sessions" = "add",
	) {
		if (actionBusy.current) return;
		actionBusy.current = true;
		setActivity(kind);
		setPending(true);
		setMessage("");
		setFailed(false);
		try {
			const result = await action();
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
				await passkeys.refetch();
				if (kind === "sessions")
					await queryClient.invalidateQueries({
						queryKey: ["account-web-sessions", user.id],
					});
			}
		} catch {
			setFailed(true);
			setMessage(m.the_action_was_not_completed_please_try_again());
		} finally {
			actionBusy.current = false;
			setPending(false);
		}
	}

	async function signOut() {
		if (actionBusy.current) return;
		actionBusy.current = true;
		setActivity("signout");
		setPending(true);
		setMessage("");
		setFailed(false);
		try {
			const failure = await signOutOfApplication(router, setFeedback);
			if (failure) {
				setFailed(true);
				setMessage(failure);
			}
		} finally {
			actionBusy.current = false;
			setPending(false);
		}
	}

	return (
		<div className="relative flex min-w-0 flex-col gap-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<h1
						ref={heading}
						tabIndex={-1}
						className="text-2xl font-semibold tracking-tight"
					>
						{m.user_profile()}
					</h1>
				</div>
				<Button
					variant="outline"
					onClick={signOut}
					disabled={!hydrated || pending}
					pending={pending && activity === "signout"}
					pendingLabel={m.signing_out()}
				>
					<LogOutIcon aria-hidden="true" />
					{m.sign_out()}
				</Button>
			</div>
			<FormFeedback
				message={activity === "signout" ? message : ""}
				kind={failed ? "error" : "success"}
				pending={pending && activity === "signout"}
				pendingMessage={m.signing_out()}
				reserveLine={false}
			/>
			<ProfileDetails />
			<SettingsSection
				id="passkeys"
				title={m.passkeys()}
				description={m.passkey_recovery_help()}
			>
				<form
					method="post"
					className="flex flex-wrap items-end gap-2"
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
						{m.add_a_passkey()}
					</Button>
				</form>
				{identity.pending || passkeys.isPending || passkeys.isFetching ? (
					<div>
						<p role="status">{m.loading_passkeys()}</p>
						<Skeleton aria-hidden="true" className="mt-2 h-12 w-full" />
					</div>
				) : passkeys.error ? (
					<p role="alert">
						{m.could_not_load_passkeys_try_refreshing_the_page()}
					</p>
				) : passkeys.data?.length ? (
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
												<SessionTime value={key.createdAt} />
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
														<AlertDialogFooter>
															<Button
																variant="destructive"
																disabled={!hydrated || pending}
																pending={pending && activity === "remove"}
																pendingLabel={m.removing_passkey()}
																onClick={() =>
																	runAction(
																		() =>
																			authClient.passkey.deletePasskey({
																				id: key.id,
																			}),
																		key.id,
																		"remove",
																	)
																}
															>
																{m.confirm_removal()}
															</Button>
															<AlertDialogCancel
																variant="ghost"
																disabled={!hydrated || pending}
																onClick={() => setDeleteId(null)}
															>
																{m.cancel()}
															</AlertDialogCancel>
														</AlertDialogFooter>
													</AlertDialogContent>
												</AlertDialog>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Card>
				) : (
					<p className="text-sm">{m.no_passkeys_registered_yet()}</p>
				)}
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
							() => authClient.revokeOtherSessions(),
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
					<DialogHeader>
						<DialogTitle>{m.rename_passkey()}</DialogTitle>
						<DialogDescription>{m.passkey_name()}</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							if (renameId && renameName.trim() && !pending)
								void runAction(
									() =>
										authClient.passkey.updatePasskey({
											id: renameId,
											name: renameName.trim(),
										}),
									undefined,
									"rename",
								);
						}}
						className="flex flex-col gap-4"
					>
						<Label htmlFor="rename-passkey-name">{m.name()}</Label>
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
						/>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								disabled={pending}
								onClick={() => setRenameId(null)}
							>
								{m.cancel()}
							</Button>
							<Button
								type="submit"
								disabled={pending || !renameName.trim()}
								pending={pending && activity === "rename"}
							>
								{m.save_name()}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
