import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../auth/client";
import { getCurrentUser } from "../auth/session.functions";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/account")({
	beforeLoad: async () => {
		const user = await getCurrentUser();
		if (!user) throw redirect({ to: "/login" });
		return { user };
	},
	headers: () => ({ "Cache-Control": "private, no-store" }),
	component: Account,
});

function Account() {
	const { user } = Route.useRouteContext();
	const router = useRouter();
	const passkeys = authClient.useListPasskeys();
	const [name, setName] = useState("");
	const [message, setMessage] = useState("");
	const [pending, setPending] = useState(false);
	const [deleteId, setDeleteId] = useState<string | null>(null);

	async function runAction(
		action: () => Promise<{
			error: { code?: string; message?: string } | null;
		}>,
	) {
		setPending(true);
		setMessage("");
		try {
			const result = await action();
			if (result.error) {
				setMessage(
					result.error.code === "SESSION_NOT_FRESH"
						? "Please sign in again before changing your account security."
						: "The action was not completed. Please try again.",
				);
			} else {
				setMessage("Account security updated.");
				setDeleteId(null);
			}
		} catch {
			setMessage("The action was not completed. Please try again.");
		} finally {
			setPending(false);
		}
	}

	async function signOut() {
		setPending(true);
		setMessage("");
		try {
			const result = await authClient.signOut();
			if (result.error) {
				setMessage("Sign-out failed. Please try again.");
				return;
			}
			await router.invalidate({ sync: true });
			await router.navigate({ to: "/login", replace: true });
		} catch {
			setMessage("Sign-out failed. Please try again.");
		} finally {
			setPending(false);
		}
	}

	return (
		<main className="mx-auto flex min-h-svh max-w-xl flex-col gap-6 px-6 py-12">
			<div className="flex items-center justify-between gap-4">
				<Link to="/" className="text-sm text-muted-foreground">
					PFE Telemetry
				</Link>
				<Button variant="outline" onClick={signOut} disabled={pending}>
					Sign out
				</Button>
			</div>
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">
					Account security
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">{user.email}</p>
			</div>
			<section
				className="flex flex-col gap-4 rounded-lg border p-5"
				aria-labelledby="passkeys-title"
			>
				<h2 id="passkeys-title" className="font-semibold">
					Passkeys
				</h2>
				<p className="text-sm text-muted-foreground">
					Add a passkey for faster sign-in. Email links remain available if you
					lose access to your passkeys.
				</p>
				{passkeys.isPending ? (
					<p role="status">Loading passkeys…</p>
				) : passkeys.error ? (
					<p role="alert">Could not load passkeys. Try refreshing the page.</p>
				) : passkeys.data?.length ? (
					<ul className="divide-y">
						{passkeys.data.map((key) => (
							<li
								key={key.id}
								className="flex flex-wrap items-center justify-between gap-3 py-3"
							>
								<span className="text-sm">{key.name || "Passkey"}</span>
								{deleteId === key.id ? (
									<div className="flex items-center gap-2">
										<Button
											variant="destructive"
											disabled={pending}
											onClick={() =>
												runAction(() =>
													authClient.passkey.deletePasskey({ id: key.id }),
												)
											}
										>
											Confirm removal
										</Button>
										<Button
											variant="ghost"
											disabled={pending}
											onClick={() => setDeleteId(null)}
										>
											Cancel
										</Button>
									</div>
								) : (
									<Button
										variant="outline"
										disabled={pending}
										onClick={() => setDeleteId(key.id)}
									>
										Remove
									</Button>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm">No passkeys registered yet.</p>
				)}
				<label htmlFor="passkey-name" className="text-sm font-medium">
					Passkey name
				</label>
				<input
					id="passkey-name"
					value={name}
					maxLength={100}
					placeholder="For example, personal laptop"
					onChange={(event) => setName(event.target.value)}
					className="h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
				/>
				<Button
					disabled={pending}
					onClick={() =>
						runAction(() =>
							authClient.passkey.addPasskey({ name: name.trim() || undefined }),
						)
					}
				>
					Add a passkey
				</Button>
			</section>
			<section
				className="flex flex-col items-start gap-3 rounded-lg border p-5"
				aria-labelledby="sessions-title"
			>
				<h2 id="sessions-title" className="font-semibold">
					Other sessions
				</h2>
				<p className="text-sm text-muted-foreground">
					After recovering access, sign out other sessions and remove any
					passkeys you no longer trust.
				</p>
				<Button
					variant="outline"
					disabled={pending}
					onClick={() => runAction(() => authClient.revokeOtherSessions())}
				>
					Sign out other sessions
				</Button>
			</section>
			<p role="status" aria-live="polite" className="text-sm">
				{message}
			</p>
			<Link to="/login" className="text-sm underline">
				Sign in again
			</Link>
		</main>
	);
}
