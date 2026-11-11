import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuthenticationController } from "../../src/auth/authentication";
import { LocaleSafety } from "../../src/components/locale-safety";
import { MutationFeedback } from "../../src/components/mutation-feedback";
import { useAppMutation } from "../../src/components/use-app-mutation";
import { usePageConfirmation } from "../../src/components/use-page-confirmation";
import { gate as createGate } from "../gate";

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
let failReload = false;
let navigateAfterSave = false;
let settled = 0;
let reads = 0;
let deferRefresh = false;
let resumeRefresh: (() => void) | null = null;
let refreshResult: boolean | null = null;
const writes: {
	input: { name: string; requestId: string };
	resolve: (data: { data: { id: string }; error: null }) => void;
	reject: (error: Error) => void;
}[] = [];

function Editor() {
	const [name, setName] = useState("Normalized");
	const [confirmation, confirm] = usePageConfirmation<string>();
	const mutation = useAppMutation({
		userId: "actor",
		receiptBacked: true,
		save: (input: { name: string; requestId: string }) =>
			new Promise<{ data: { id: string }; error: null }>((resolve, reject) => {
				writes.push({ input, resolve, reject });
			}),
	});
	async function settle(result: Awaited<ReturnType<typeof mutation.submit>>) {
		try {
			if (!result || result.error) return;
			if (deferRefresh) {
				const refreshGate = createGate();
				resumeRefresh = refreshGate.release;
				await refreshGate.promise;
			}
			refreshResult = await result.refresh(async (navigate) => {
				if (!navigateAfterSave) return;
				await navigate({ to: "/settings", search: { section: "user" } });
			});
		} finally {
			settled++;
		}
	}
	return (
		<>
			<button type="button" onClick={() => confirm("Confirm change")}>
				Open confirmation
			</button>
			{confirmation && <p>{confirmation}</p>}
			<label>
				Draft
				<input value={name} onChange={(event) => setName(event.target.value)} />
			</label>
			<button
				type="button"
				disabled={
					mutation.disabled ||
					["uncertain", "saved", "refresh-failed"].includes(mutation.status)
				}
				onClick={() =>
					void mutation
						.submit({ name: name.trim(), requestId: crypto.randomUUID() })
						.then(settle)
				}
			>
				Save
			</button>
			{mutation.canRetry && (
				<button
					type="button"
					disabled={mutation.pending}
					onClick={() => void mutation.retry().then(settle)}
				>
					Retry creation
				</button>
			)}
			<output data-testid="outcome">
				{mutation.status}:{mutation.message}
			</output>
			<output data-testid="pending">{String(mutation.pending)}</output>
			{mutation.data && <a href={`#${mutation.data.id}`}>Saved link</a>}
		</>
	);
}
const root = createRootRouteWithContext<{
	queryClient: QueryClient;
	authentication: typeof authentication;
}>()({
	beforeLoad: () => ({ user: { id: "actor" } }),
	component: () => (
		<QueryClientProvider client={queryClient}>
			<LocaleSafety>
				<MutationFeedback>
					<Link to="/">Editor</Link>
					<Link to="/settings" search={{ section: "user" }}>
						Other
					</Link>
					<Link to="/" hash="content">
						Fragment
					</Link>
					<Outlet />
				</MutationFeedback>
			</LocaleSafety>
		</QueryClientProvider>
	),
});
const edit = createRoute({
	getParentRoute: () => root,
	path: "/",
	loader: () => {
		reads++;
		if (failReload) throw new Error("Reload unavailable");
	},
	component: Editor,
	errorComponent: () => <h1>Reload failed</h1>,
});
const other = createRoute({
	getParentRoute: () => root,
	path: "/settings",
	component: () => <h1>Other page</h1>,
});
const router = createRouter({
	routeTree: root.addChildren([edit, other]),
	context: { queryClient, authentication },
	defaultPendingMs: 0,
	defaultPendingMinMs: 0,
});

declare global {
	interface Window {
		mutationTest: {
			writes: () => (typeof writes)[number]["input"][];
			settled: () => number;
			reads: () => number;
			idle: () => boolean;
			holdRefresh: () => void;
			awaitingRefresh: () => boolean;
			continueRefresh: () => void;
			refreshResult: () => boolean | null;
			deliver: (index: number) => void;
			lose: (index: number) => void;
			identity: () => void;
			broadcastIdentity: () => void;
			failReload: () => void;
			recoverReload: () => void;
			navigateAfterSave: () => void;
		};
	}
}
window.mutationTest = {
	writes: () => writes.map(({ input }) => input),
	settled: () => settled,
	reads: () => reads,
	idle: () => !router.state.isLoading,
	holdRefresh: () => {
		deferRefresh = true;
	},
	awaitingRefresh: () => resumeRefresh !== null,
	continueRefresh: () => {
		const resume = resumeRefresh;
		resumeRefresh = null;
		resume?.();
	},
	refreshResult: () => refreshResult,
	deliver: (index) =>
		writes[index].resolve({ data: { id: "saved" }, error: null }),
	lose: (index) => writes[index].reject(new Error("Lost response")),
	identity: () => authentication.begin("verify")?.finish(),
	broadcastIdentity: () =>
		getGlobalBroadcastChannel().post({
			event: "session",
			data: { trigger: "getSession" },
			clientId: crypto.randomUUID(),
		}),
	failReload: () => {
		failReload = true;
	},
	recoverReload: () => {
		failReload = false;
	},
	navigateAfterSave: () => {
		navigateAfterSave = true;
	},
};
const element = document.getElementById("root");
if (!element) throw new Error("Missing fixture root");
createRoot(element).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
