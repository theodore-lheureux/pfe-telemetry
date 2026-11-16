import { m } from "@recount/i18n/messages";
import { useEffect, useRef, useState } from "react";
import { accountContextHeader } from "../../auth/account-context";
import { authClient } from "../../auth/client";
import { profileEmailError } from "../../auth/profile-email";
import { useLocaleChangeBlocker } from "../locale-safety";
import { useStepUpAuthentication } from "../step-up-authentication";
import { useMutationOwner } from "../use-mutation-owner";
import { usePageConfirmation } from "../use-page-confirmation";

export function useProfileEmailChange(user: { id: string; email: string }) {
	const [open, setOpen] = usePageConfirmation<true>();
	const [address, setAddress] = useState("");
	const [sent, setSent] = useState(false);
	const [message, setMessage] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const requireStepUp = useStepUpAuthentication();
	const { begin, router } = useMutationOwner(user.id);
	const live = authClient.useSession();
	const accountMatches =
		!live.isPending &&
		!live.error &&
		live.data?.user.id === user.id &&
		live.data.user.email === user.email;
	useLocaleChangeBlocker(pending);
	useEffect(() => {
		if (!open || live.isPending || accountMatches) return;
		setOpen(null);
		setSent(false);
		setAddress("");
		setMessage("");
		if (!live.error) void router.invalidate({ sync: true }).catch(() => {});
	}, [open, live.isPending, live.error, accountMatches, setOpen, router]);

	function close() {
		if (busy.current) return;
		setOpen(null);
		setSent(false);
		setAddress("");
		setMessage("");
	}

	async function submit() {
		if (busy.current || sent || !accountMatches) return;
		busy.current = true;
		const verified = await requireStepUp({
			userId: user.id,
			email: user.email,
		});
		busy.current = false;
		if (!verified) return;
		setOpen(true);
		const operation = begin(() => {
			busy.current = false;
			setPending(false);
			setOpen(null);
			setSent(false);
		});
		if (!operation) return;
		busy.current = true;
		setPending(true);
		setMessage("");
		try {
			const headers: Record<string, string> = {
				"content-type": "application/json",
				[accountContextHeader]: user.id,
			};
			const response = await fetch("/api/auth/change-email", {
				method: "POST",
				headers,
				body: JSON.stringify({
					newEmail: address.trim(),
				}),
				signal: operation.signal,
			});
			const data = await response.json();
			if (!operation.current()) return;
			if (!response.ok) {
				setMessage(profileEmailError(data.code, response.status));
				return;
			}
			setAddress(address.trim().toLowerCase());
			setSent(true);
		} catch {
			if (operation.current()) setMessage(m.profile_email_change_failed());
		} finally {
			if (operation.current()) {
				busy.current = false;
				setPending(false);
			}
			operation.finish();
		}
	}

	return {
		open,
		start: async () => {
			if (busy.current || !accountMatches) return;
			busy.current = true;
			const verified = await requireStepUp({
				userId: user.id,
				email: user.email,
			});
			busy.current = false;
			if (!verified) return;
			setMessage("");
			setOpen(true);
		},
		close,
		address,
		setAddress,
		sent,
		message,
		pending,
		accountMatches,
		submit,
	};
}
