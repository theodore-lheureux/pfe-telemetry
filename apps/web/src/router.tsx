import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RouteError, RoutePending } from "./components/route-feedback";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient();
	const router = createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		defaultPendingComponent: RoutePending,
		defaultErrorComponent: RouteError,
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
