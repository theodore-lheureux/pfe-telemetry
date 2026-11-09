import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { authClient } from "./client";

export function useAccountPasskeys() {
	const { user, authentication } = getRouteApi("/_app").useRouteContext();
	const hydrated = useHydrated();
	const identity = useSyncExternalStore(
		authentication.subscribe,
		authentication.getSnapshot,
		authentication.getSnapshot,
	);
	const passkeys = useQuery({
		queryKey: ["account-passkeys", user.id, identity.revision],
		enabled: hydrated && !identity.pending,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async ({ signal }) => {
			const result = await authClient.passkey.listUserPasskeys({
				fetchOptions: { signal, timeout: 10_000 },
			});
			const current = authentication.getSnapshot();
			if (
				current.pending ||
				current.revision !== identity.revision ||
				result.error ||
				!result.data ||
				result.data.some((key) => key.userId !== user.id)
			)
				throw new Error("Passkeys could not be confirmed for this account");
			return result.data;
		},
	});
	return { passkeys, identity };
}
