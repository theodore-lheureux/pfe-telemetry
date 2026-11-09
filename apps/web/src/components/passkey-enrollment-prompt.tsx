import { m } from "@recount/i18n/messages";
import { getRouteApi, Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useAccountPasskeys } from "../auth/use-account-passkeys";
import { settingsSearch } from "./settings-links";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

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
	useEffect(() => {
		if (passkeys.data?.length)
			authentication.dismissPasskeyPrompt(identity.revision);
	}, [passkeys.data, authentication, identity.revision]);
	if (!passkeys.isSuccess || passkeys.data.length) return null;
	const dismiss = () => authentication.dismissPasskeyPrompt(identity.revision);
	return (
		<Alert
			role="region"
			aria-labelledby="passkey-enrollment-title"
			className="border-primary/25 bg-primary/5 p-4"
		>
			<KeyRoundIcon aria-hidden="true" className="size-5 text-primary" />
			<AlertTitle id="passkey-enrollment-title">
				{m.passkey_prompt_title()}
			</AlertTitle>
			<AlertDescription className="flex flex-col gap-3">
				<p>{m.passkey_prompt_description()}</p>
				<div className="flex flex-wrap gap-2">
					<Button asChild>
						<Link
							to="/settings"
							search={settingsSearch("user", selection)}
							hash="passkeys"
							onClick={dismiss}
						>
							{m.passkey_prompt_setup()}
						</Link>
					</Button>
					<Button variant="ghost" onClick={dismiss}>
						{m.passkey_prompt_later()}
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	);
}
