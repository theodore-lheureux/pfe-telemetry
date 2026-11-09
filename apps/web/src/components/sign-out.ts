import { m } from "@recount/i18n/messages";
import type { useRouter } from "@tanstack/react-router";
import { authClient } from "../auth/client";
import {
	clearBetterAuthIdentity,
	refreshBetterAuthIdentity,
} from "../auth/identity-state";
import { settleIdentityRefresh } from "../auth/refresh";
import type { useMutationFeedback } from "./mutation-feedback";

export async function signOutOfApplication(
	router: ReturnType<typeof useRouter>,
	setFeedback: ReturnType<typeof useMutationFeedback>,
) {
	try {
		const result = await authClient.signOut();
		if (result.error) return m.signout_failed_please_try_again();
		await router.navigate({ to: "/login", replace: true });
		return "";
	} catch {
		return m.signout_failed_please_try_again();
	} finally {
		const authentication = router.options.context.authentication;
		authentication.dismissPasskeyPrompt(authentication.getSnapshot().revision);
		clearBetterAuthIdentity();
		router.options.context.queryClient.clear();
		setFeedback(null);
		router.clearCache();
		await settleIdentityRefresh(async () => {
			await refreshBetterAuthIdentity();
			await router.invalidate({ sync: true });
		});
	}
}
