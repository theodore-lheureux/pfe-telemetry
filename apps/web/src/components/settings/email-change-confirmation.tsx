import { m } from "@recount/i18n/messages";
import { Link, useHydrated } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { accountContextHeader } from "../../auth/account-context";
import { refreshBetterAuthIdentity } from "../../auth/identity-state";
import { profileEmailError } from "../../auth/profile-email";
import { FormFeedback } from "../form-feedback";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useStepUpAuthentication } from "../step-up-authentication";
import { Button } from "../ui/button";
import { useMutationOwner } from "../use-mutation-owner";

export function EmailChangeConfirmation({
	user,
	token,
	accountId,
}: {
	user: { id: string; email: string };
	token: string;
	accountId: string;
}) {
	const [pending, setPending] = useState(false);
	const [saved, setSaved] = useState(false);
	const [message, setMessage] = useState("");
	const busy = useRef(false);
	const stepUp = useStepUpAuthentication();
	const { begin } = useMutationOwner(user.id);
	const hydrated = useHydrated();
	useLocaleChangeBlocker(pending);
	async function confirm() {
		if (busy.current || saved) return;
		busy.current = true;
		try {
			if (!(await stepUp({ userId: user.id, email: user.email }))) return;
			const operation = begin(() => setPending(false));
			if (!operation) return;
			setPending(true);
			setMessage("");
			try {
				const response = await fetch(
					`/api/auth/verify-email?${new URLSearchParams({ token })}`,
					{
						headers: { [accountContextHeader]: accountId },
						signal: operation.signal,
					},
				);
				const result = await response.json();
				if (!operation.current()) return;
				if (!response.ok) {
					setMessage(profileEmailError(result.code, response.status));
					return;
				}
				setSaved(true);
				await refreshBetterAuthIdentity();
				await operation.refresh(
					m.profile_email_change_saved(),
					m.your_change_was_saved_but_the_page_could_2(),
				);
			} catch {
				if (operation.current()) setMessage(m.profile_email_change_failed());
			} finally {
				if (operation.current()) setPending(false);
				operation.finish();
			}
		} finally {
			busy.current = false;
		}
	}
	return (
		<section className="mx-auto flex max-w-md flex-col gap-4 p-6">
			<h1 className="text-xl font-semibold">
				{m.profile_email_change_title()}
			</h1>
			<p>{m.profile_email_change_link_help()}</p>
			<FormFeedback
				message={saved ? "" : message}
				kind="error"
				pending={pending}
			/>
			{!saved && (
				<Button disabled={!hydrated || pending} onClick={() => void confirm()}>
					{m.profile_email_change_confirm()}
				</Button>
			)}
			<Link to="/settings" search={{ section: "user" }} className="underline">
				{m.profile_email_change_review_security()}
			</Link>
		</section>
	);
}
