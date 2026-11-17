import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuthenticationController } from "../../src/auth/authentication";
import { LocaleSafety } from "../../src/components/locale-safety";
import { MutationFeedback } from "../../src/components/mutation-feedback";
import { DeveloperToolbar } from "../../src/developer/toolbar";

const queryClient = new QueryClient();
const authentication = createAuthenticationController({
	readState: async () => ({
		twoFactorPending: false,
		observedAt: new Date(),
		freshAgeSeconds: 60,
		session: null,
	}),
	clearPrivateIdentity: () => queryClient.clear(),
	refreshIdentity: async () => {},
});
function Fixture() {
	const [developer, setDeveloper] = useState(
		!location.search.includes("ordinary"),
	);
	const [actions, setActions] = useState(0);
	return (
		<>
			<section className="max-w-sm space-y-3 p-6">
				<label className="block">
					Site search
					<input aria-label="Site search" className="ml-2 border" />
				</label>
				<button
					type="button"
					className="border px-3 py-1"
					onClick={() => setActions((count) => count + 1)}
				>
					Site action ({actions})
				</button>
			</section>
			<button
				type="button"
				onClick={() => {
					queryClient.clear();
					setDeveloper(false);
				}}
			>
				Change account
			</button>
			<DeveloperToolbar
				key={String(developer)}
				userId={developer ? "developer" : "ordinary"}
				reference={{
					organizationId: "org",
					projectId: "11111111-1111-4111-8111-111111111111",
				}}
				capability={developer ? { enabled: true, gpuEnabled: false } : null}
			/>
		</>
	);
}
const root = createRootRouteWithContext<{
	queryClient: QueryClient;
	authentication: typeof authentication;
}>()({
	beforeLoad: () => ({ user: { id: "developer" } }),
	component: () => (
		<QueryClientProvider client={queryClient}>
			<LocaleSafety>
				<MutationFeedback>
					<Fixture />
					<Outlet />
				</MutationFeedback>
			</LocaleSafety>
		</QueryClientProvider>
	),
});
const router = createRouter({
	routeTree: root,
	context: { queryClient, authentication },
});
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
createRoot(element).render(<RouterProvider router={router} />);
