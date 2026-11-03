import {
	createFileRoute,
	Link,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../auth/client";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>): { error?: string } => ({
		error: typeof search.error === "string" ? search.error : undefined,
	}),
	component: Login,
});

function Login() {
	const { error } = Route.useSearch();
	const router = useRouter();
	const hydrated = useHydrated();
	const [email, setEmail] = useState("");
	const [pending, setPending] = useState(false);
	const passkeysSupported =
		hydrated && window.isSecureContext && "PublicKeyCredential" in window;
	const [message, setMessage] = useState("");

	async function signInWithPasskey() {
		setPending(true);
		setMessage("");
		try {
			const result = await authClient.signIn.passkey();
			if (result.error) {
				setMessage(
					"Passkey sign-in was not completed. Try again or use email.",
				);
			} else {
				await router.invalidate({ sync: true });
				await router.navigate({ to: "/account", replace: true });
			}
		} catch {
			setMessage("Sign-in is unavailable. Please try again.");
		} finally {
			setPending(false);
		}
	}

	async function signInWithEmail(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setMessage("");
		try {
			const result = await authClient.signIn.magicLink({
				email,
				callbackURL: "/account",
				newUserCallbackURL: "/account",
				errorCallbackURL: "/login",
			});
			setMessage(
				result.error
					? "We could not send a sign-in link. Please try again later."
					: "If this address can sign in, a link is on its way. Check your inbox; it expires in five minutes.",
			);
		} catch {
			setMessage("We could not send a sign-in link. Please try again later.");
		} finally {
			setPending(false);
		}
	}

	return (
		<main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-6 py-12">
			<Link to="/" className="text-sm text-muted-foreground">
				PFE Telemetry
			</Link>
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Use a passkey, or get a secure sign-in link by email.
				</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					This sign-in link is invalid, expired, or cannot create an account.
					Request a new link or contact your administrator.
				</p>
			)}
			<Button
				size="lg"
				disabled={pending || !passkeysSupported}
				onClick={signInWithPasskey}
			>
				Sign in with a passkey
			</Button>
			{!passkeysSupported && (
				<p className="text-sm text-muted-foreground">
					Passkeys require a supported browser and HTTPS, or localhost for
					development.
				</p>
			)}
			<form
				method="post"
				onSubmit={signInWithEmail}
				className="flex flex-col gap-3 border-t pt-6"
			>
				<label htmlFor="email" className="text-sm font-medium">
					Email address
				</label>
				<input
					id="email"
					name="email"
					type="email"
					autoComplete="email"
					required
					disabled={!hydrated || pending}
					maxLength={254}
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					className="h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
				/>
				<Button
					size="lg"
					variant="outline"
					type="submit"
					disabled={!hydrated || pending}
				>
					Email me a sign-in link
				</Button>
				<p className="text-sm text-muted-foreground">
					New here or lost your passkeys? Start with email. New accounts are
					available only when registration is enabled.
				</p>
			</form>
			<p role="status" aria-live="polite" className="text-sm">
				{message}
			</p>
		</main>
	);
}
