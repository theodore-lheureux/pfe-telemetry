import { m } from "@recount/i18n/messages";
import { getRouteApi, Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAccountPasskeys } from "../auth/use-account-passkeys";
import { settingsSearch } from "./settings-links";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

export function PasskeyEnrollmentPrompt({
	selection,
}: {
	selection: { organizationId?: string; projectId?: string };
}) {
	const { user, authentication } = getRouteApi("/_app").useRouteContext();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	if (identity.pending || identity.passkeyPromptFor !== user.id) return null;
	return (
		<EnrollmentPrompt
			key={`${user.id}/${identity.revision}`}
			selection={selection}
		/>
	);
}

function EnrollmentPrompt({
	selection,
}: {
	selection: { organizationId?: string; projectId?: string };
}) {
	const { authentication } = getRouteApi("/_app").useRouteContext();
	const { passkeys, identity } = useAccountPasskeys();
	const later = useRef<HTMLButtonElement>(null);
	const navigating = useRef(false);
	useEffect(() => {
		if (passkeys.data?.length)
			authentication.dismissPasskeyPrompt(identity.revision);
	}, [passkeys.data, authentication, identity.revision]);
	if (!passkeys.isSuccess || passkeys.data.length) return null;
	const dismiss = () => authentication.dismissPasskeyPrompt(identity.revision);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) dismiss();
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					later.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (!navigating.current)
						document
							.getElementById("main-content")
							?.focus({ preventScroll: true });
				}}
			>
				<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<KeyRoundIcon aria-hidden="true" className="size-6" />
				</div>
				<DialogHeader>
					<DialogTitle>{m.passkey_prompt_title()}</DialogTitle>
					<DialogDescription>
						{m.passkey_prompt_description()}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button ref={later} variant="ghost" onClick={dismiss}>
						{m.passkey_prompt_later()}
					</Button>
					<Button asChild>
						<Link
							to="/settings"
							search={settingsSearch("user", selection)}
							hash="passkeys"
							onClick={() => {
								navigating.current = true;
								dismiss();
							}}
						>
							{m.passkey_prompt_setup()}
						</Link>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
