import { m } from "@pfe/i18n/messages";
import { useSelector } from "@tanstack/react-form";
import {
	createFileRoute,
	Link,
	type SearchSchemaInput,
	useHydrated,
	useRouter,
} from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../auth/client";
import { loginSearch, signInDestinations } from "../auth/redirect";
import { useAppForm } from "../components/app-form";
import { useLocaleChangeBlocker } from "../components/locale-safety";
import { useMutationFeedback } from "../components/mutation-feedback";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";

const currentOrigin = createIsomorphicFn()
	.server(() => getRequestUrl().origin)
	.client(() => window.location.origin);

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
		loginSearch(search, currentOrigin()),
	head: () => ({ meta: [{ title: `${m.sign_in()} · ${m.app_title()}` }] }),
	component: Login,
});

function Login() {
	const { error, redirect } = Route.useSearch();
	const router = useRouter();
	const hydrated = useHydrated();
	const setFeedback = useMutationFeedback();
	const [passkeyPending, setPasskeyPending] = useState(false);
	const form = useAppForm({
		defaultValues: { email: "" },
		onSubmit: async ({ value }) => signInWithEmail(value.email),
	});
	const emailPending = useSelector(form.store, (state) => state.isSubmitting);
	const pending = passkeyPending || emailPending;
	useLocaleChangeBlocker(pending);
	const passkeysSupported =
		hydrated && window.isSecureContext && "PublicKeyCredential" in window;
	const [message, setMessage] = useState("");
	const lifetime = useRef({ mounted: false, generation: 0 });
	useEffect(() => {
		const state = lifetime.current;
		state.mounted = true;
		const stop = router.subscribe(
			"onBeforeNavigate",
			({ fromLocation, toLocation }) => {
				if (
					fromLocation?.href !== toLocation.href ||
					fromLocation?.state.__TSR_key !== toLocation.state.__TSR_key
				)
					state.generation++;
			},
		);
		return () => {
			state.mounted = false;
			state.generation++;
			stop();
		};
	}, [router]);

	async function signInWithPasskey() {
		if (pending || !passkeysSupported) return;
		const generation = ++lifetime.current.generation;
		const current = () =>
			lifetime.current.mounted && lifetime.current.generation === generation;
		setPasskeyPending(true);
		setMessage("");
		try {
			const result = await authClient.signIn.passkey();
			if (!current()) return;
			if (result.error) {
				setMessage(m.passkey_signin_was_not_completed_try_again_or());
			} else {
				router.options.context.queryClient.clear();
				setFeedback(null);
				router.clearCache();
				await router.invalidate({ sync: true });
				if (!current()) return;
				await router.navigate({ href: redirect, replace: true });
			}
		} catch {
			if (current()) setMessage(m.signin_is_unavailable_please_try_again());
		} finally {
			if (lifetime.current.mounted) setPasskeyPending(false);
		}
	}

	async function signInWithEmail(email: string) {
		if (!hydrated || passkeyPending) return;
		const generation = ++lifetime.current.generation;
		setMessage("");
		try {
			const result = await authClient.signIn.magicLink({
				email,
				...signInDestinations(redirect),
			});
			if (
				!lifetime.current.mounted ||
				lifetime.current.generation !== generation
			)
				return;
			setMessage(
				result.error
					? m.we_could_not_send_a_signin_link_please()
					: m.if_this_address_can_sign_in_a_link(),
			);
		} catch {
			if (
				lifetime.current.mounted &&
				lifetime.current.generation === generation
			)
				setMessage(m.we_could_not_send_a_signin_link_please());
		}
	}

	return (
		<main className="mx-auto my-8 flex w-[calc(100%_-_2rem)] max-w-md flex-col gap-6 rounded-lg border bg-card p-5 text-card-foreground sm:my-16">
			<Link to="/" className="text-sm text-muted-foreground">
				{m.app_title()}
			</Link>
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">{m.sign_in()}</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{m.use_a_passkey_or_get_a_secure_signin()}
				</p>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>
						{m.this_signin_link_is_invalid_expired_or_cannot()}
					</AlertDescription>
				</Alert>
			)}
			<Button
				size="lg"
				disabled={pending || !passkeysSupported}
				onClick={signInWithPasskey}
			>
				{m.sign_in_with_a_passkey()}
			</Button>
			{!passkeysSupported && (
				<p className="text-sm text-muted-foreground">
					{m.passkeys_require_a_supported_browser_and_https_or()}
				</p>
			)}
			<form
				method="post"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
				className="flex flex-col gap-3 border-t pt-6"
			>
				<form.AppField name="email">
					{(field) => (
						<field.TextField
							id="email"
							label={m.email_address()}
							type="email"
							autoComplete="email"
							required
							disabled={!hydrated || pending}
							maxLength={254}
						/>
					)}
				</form.AppField>
				<Button
					size="lg"
					variant="outline"
					type="submit"
					disabled={!hydrated || pending}
				>
					{m.email_me_a_signin_link()}
				</Button>
				<p className="text-sm text-muted-foreground">
					{m.new_here_or_lost_your_passkeys_start_with()}
				</p>
			</form>
			<p role="status" aria-live="polite" className="text-sm">
				{message}
			</p>
		</main>
	);
}
