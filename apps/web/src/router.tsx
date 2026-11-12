import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createAuthenticationController } from "./auth/authentication";
import { getAuthenticationState } from "./auth/authentication-state.functions";
import {
	clearBetterAuthIdentity,
	refreshBetterAuthIdentity,
} from "./auth/identity-state";
import { PageError, RoutePending } from "./components/route-feedback";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient();
	const authentication = createAuthenticationController({
		readState: async (signal) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(abort, 10_000);
			try {
				return await getAuthenticationState({ signal: controller.signal });
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
			}
		},
		clearPrivateIdentity: () => {
			queryClient.clear();
			clearBetterAuthIdentity();
			router.clearCache();
		},
		refreshIdentity: async () => {
			await refreshBetterAuthIdentity();
			await router.invalidate({ sync: true });
		},
	});
	const router = createRouter({
		routeTree,
		context: { queryClient, authentication },
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		defaultStaleTime: 0,
		defaultGcTime: 0,
		defaultPreloadGcTime: 0,
		defaultStaleReloadMode: "blocking",
		defaultPendingComponent: RoutePending,
		defaultErrorComponent: PageError,
		scrollRestoration: true,
	});

	setupRouterSsrQueryIntegration({ router, queryClient });
	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
