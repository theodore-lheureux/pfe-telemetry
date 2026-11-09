import { m } from "@recount/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { useRef, useState, useSyncExternalStore } from "react";
import { authClient } from "@/auth/client";
import {
	clearBetterAuthIdentity,
	refreshBetterAuthIdentity,
} from "@/auth/identity-state";
import { settleIdentityRefresh } from "@/auth/refresh";
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
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_app/account")({
	headers: () => ({ "Cache-Control": "private, no-store" }),
	head: () => ({
		meta: [{ title: `${m.account_security()} · ${m.app_title()}` }],
	}),
	component: Account,
});

function Account() {
	const { user, authentication } = Route.useRouteContext();
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useMutationFeedback();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	const passkeys = useQuery({
		queryKey: ["account-passkeys", user.id, identity.revision],
		enabled: hydrated && !identity.pending,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async ({ signal }) => {
			const result = await authClient.passkey.listUserPasskeys({
				fetchOptions: { signal, timeout: 10_000 },
			});
			const current = authentication.getSnapshot();
			if (
				current.pending ||
				current.revision !== identity.revision ||
				result.error ||
				!result.data ||
				result.data.some((key) => key.userId !== user.id)
			)
				throw new Error("Passkeys could not be confirmed for this account");
			return result.data;
		},
	});
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const [activity, setActivity] = useState<
		"add" | "remove" | "sessions" | "signout" | null
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

	async function runAction(
		action: () => Promise<{
			error: { code?: string; message?: string } | null;
		}>,
		removedId?: string,
		kind: "add" | "remove" | "sessions" = "add",
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
				await passkeys.refetch();
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
			const result = await authClient.signOut();
			if (result.error) {
				setFailed(true);
				setMessage(m.signout_failed_please_try_again());
				return;
			}
			await router.navigate({ to: "/login", replace: true });
		} catch {
			setFailed(true);
			setMessage(m.signout_failed_please_try_again());
		} finally {
			clearBetterAuthIdentity();
			router.options.context.queryClient.clear();
			setFeedback(null);
			router.clearCache();
			await settleIdentityRefresh(async () => {
				await refreshBetterAuthIdentity();
				await router.invalidate({ sync: true });
			});
			actionBusy.current = false;
			setPending(false);
		}
	}

	return (
		<div className="flex max-w-xl flex-col gap-6">
			<div className="flex items-center justify-between gap-4">
				<Link to="/" className="text-sm text-muted-foreground">
					{m.go_home()}
				</Link>
				<Button
					variant="outline"
					onClick={signOut}
					disabled={!hydrated || pending}
					pending={pending && activity === "signout"}
					pendingLabel={m.signing_out()}
				>
					{m.sign_out()}
				</Button>
			</div>
			<FormFeedback
				message={activity === "signout" ? message : ""}
				kind={failed ? "error" : "success"}
				pending={pending && activity === "signout"}
				pendingMessage={m.signing_out()}
			/>
			<div>
				<h1
					ref={heading}
					tabIndex={-1}
					className="text-2xl font-semibold tracking-tight"
				>
					{m.account_security()}
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">{user.email}</p>
			</div>
			<section
				className="flex flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground"
				aria-labelledby="passkeys-title"
			>
				<h2 id="passkeys-title" className="font-semibold">
					{m.passkeys()}
				</h2>
				<p className="text-sm text-muted-foreground">
					{m.passkey_recovery_help()}
				</p>
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
					<ul className="divide-y">
						{passkeys.data.map((key) => (
							<li
								key={key.id}
								className="flex flex-wrap items-center justify-between gap-3 py-3"
							>
								<span className="text-sm">{key.name || m.passkey()}</span>
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
										<Button variant="outline" disabled={!hydrated || pending}>
											{m.remove()}
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent
										onEscapeKeyDown={(event) => {
											if (pending) event.preventDefault();
										}}
										onCloseAutoFocus={(event) => {
											if (completedDeletion.current === key.id || pending) {
												event.preventDefault();
												heading.current?.focus();
											}
										}}
									>
										<AlertDialogTitle>{m.confirm_removal()}</AlertDialogTitle>
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
															authClient.passkey.deletePasskey({ id: key.id }),
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
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm">{m.no_passkeys_registered_yet()}</p>
				)}
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void form.handleSubmit();
					}}
				>
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
					<Button
						type="submit"
						disabled={!hydrated || pending}
						pending={addingPasskey}
						pendingLabel={m.adding_passkey()}
					>
						{m.add_a_passkey()}
					</Button>
				</form>
				<FormFeedback
					message={
						(activity === "add" || activity === "remove") && !deleteId
							? message
							: ""
					}
					kind={failed ? "error" : "success"}
					pending={addingPasskey}
					pendingMessage={m.adding_passkey()}
				/>
			</section>
			<section
				className="flex flex-col items-start gap-3 rounded-lg border p-5"
				aria-labelledby="sessions-title"
			>
				<h2 id="sessions-title" className="font-semibold">
					{m.other_sessions()}
				</h2>
				<p className="text-sm text-muted-foreground">
					{m.after_recovering_access_sign_out_other_sessions_and()}
				</p>
				<Button
					variant="outline"
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
					{m.sign_out_other_sessions()}
				</Button>
				<FormFeedback
					message={activity === "sessions" ? message : ""}
					kind={failed ? "error" : "success"}
					pending={pending && activity === "sessions"}
					pendingMessage={m.revoking_sessions()}
				/>
			</section>
			<Link to="/login" className="text-sm underline">
				{m.sign_in_again()}
			</Link>
		</div>
	);
}
