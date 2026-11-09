import { m } from "@recount/i18n/messages";
import { getRouteApi } from "@tanstack/react-router";
import { FingerprintPatternIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerPasskey } from "../auth/passkey";
import { useAccountPasskeys } from "../auth/use-account-passkeys";
import { FormFeedback } from "./form-feedback";
import { useLocaleChangeBlocker } from "./locale-safety";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { useMutationOwner } from "./use-mutation-owner";

export function PasskeyEnrollmentPrompt() {
	const { user, authentication } = getRouteApi("/_app").useRouteContext();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	if (identity.pending || identity.passkeyPromptFor !== user.id) return null;
	return <EnrollmentPrompt key={`${user.id}/${identity.revision}`} />;
}

function EnrollmentPrompt() {
	const { user, authentication } = getRouteApi("/_app").useRouteContext();
	const { passkeys, identity } = useAccountPasskeys();
	const { begin } = useMutationOwner(user.id);
	const later = useRef<HTMLButtonElement>(null);
	const busy = useRef(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	useLocaleChangeBlocker(pending);
	useEffect(() => {
		if (passkeys.data?.length)
			authentication.dismissPasskeyPrompt(identity.revision);
	}, [passkeys.data, authentication, identity.revision]);
	if (passkeys.data === undefined || passkeys.data.length) return null;
	const dismiss = () => authentication.dismissPasskeyPrompt(identity.revision);
	async function setup() {
		if (busy.current) return;
		const operation = begin(() => {
			busy.current = false;
			setPending(false);
		});
		if (!operation) return;
		busy.current = true;
		setPending(true);
		setMessage("");
		try {
			const result = await registerPasskey(operation.signal, user.id);
			if (!operation.current()) return;
			if (result.error) {
				setMessage(
					result.error.code === "SESSION_NOT_FRESH"
						? m.error_session_fresh()
						: m.the_action_was_not_completed_please_try_again(),
				);
				await passkeys.refetch();
				return;
			}
			await passkeys.refetch();
			if (operation.current()) dismiss();
		} catch {
			if (operation.current()) {
				setMessage(m.the_action_was_not_completed_please_try_again());
				await passkeys.refetch();
			}
		} finally {
			if (operation.current()) {
				busy.current = false;
				setPending(false);
			}
			operation.finish();
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) dismiss();
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				showCloseButton={!pending}
				onEscapeKeyDown={(event) => {
					if (busy.current) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (busy.current) event.preventDefault();
				}}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					later.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					document
						.getElementById("main-content")
						?.focus({ preventScroll: true });
				}}
			>
				<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<FingerprintPatternIcon aria-hidden="true" className="size-6" />
				</div>
				<DialogHeader>
					<DialogTitle>{m.passkey_prompt_title()}</DialogTitle>
					<DialogDescription>
						{m.passkey_prompt_description()}
					</DialogDescription>
				</DialogHeader>
				<FormFeedback
					message={message}
					kind="error"
					pending={pending}
					pendingMessage={m.adding_passkey()}
					reserveLine={false}
				/>
				<DialogFooter>
					<Button
						ref={later}
						variant="ghost"
						onClick={dismiss}
						disabled={pending}
					>
						{m.passkey_prompt_later()}
					</Button>
					<Button
						onClick={() => void setup()}
						disabled={pending}
						pending={pending}
						pendingLabel={m.adding_passkey()}
					>
						<FingerprintPatternIcon aria-hidden="true" />
						{m.passkey_prompt_setup()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
