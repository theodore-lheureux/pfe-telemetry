import { m } from "@recount/i18n/messages";
import type { useRouter } from "@tanstack/react-router";
import { authClient } from "../auth/client";
import type { useMutationFeedback } from "./mutation-feedback";

export async function signOutOfApplication(
	router: ReturnType<typeof useRouter>,
	setFeedback: ReturnType<typeof useMutationFeedback>,
) {
	try {
		const succeeded = await router.options.context.authentication.signOut(
			async () => !(await authClient.signOut()).error,
			async () => {
				await router.navigate({ to: "/login", replace: true });
			},
		);
		return succeeded ? "" : m.signout_failed_please_try_again();
	} catch {
		return m.signout_failed_please_try_again();
	} finally {
		setFeedback(null);
	}
}
