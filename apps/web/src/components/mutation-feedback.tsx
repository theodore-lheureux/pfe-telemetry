import { m } from "@recount/i18n/messages";
import { useRouter } from "@tanstack/react-router";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { mutationRefreshFailed } from "../lib/mutation-refresh";
import type { FeedbackKind } from "./form-feedback";
import { useLocaleChangeBlocker } from "./locale-safety";
import { Button } from "./ui/button";
import { Toaster } from "./ui/sonner";

function NoticeToast({
	kind,
	message,
	onDismiss,
}: {
	kind: FeedbackKind;
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div className="flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-md border bg-card p-3 text-sm text-card-foreground shadow-lg">
			<p role="status" className="flex min-w-0 flex-1 items-start gap-2">
				{kind === "success" ? (
					<CircleCheckIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-primary"
					/>
				) : (
					<TriangleAlertIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0"
					/>
				)}
				{message}
			</p>
			<Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
				{m.dismiss_notice()}
			</Button>
		</div>
	);
}

interface MutationNotice {
	update: (message: string, kind?: FeedbackKind) => void;
	clear: () => void;
}

const FeedbackContext = createContext<{
	setMessage: (message: string | null, kind?: FeedbackKind) => void;
	publish: (message: string, transient?: boolean) => MutationNotice;
	capture: () => AbortSignal | null;
} | null>(null);

export function MutationFeedback({ children }: { children: ReactNode }) {
	const router = useRouter();
	const nextId = useRef(0);
	const document = useRef({
		controller: new AbortController(),
		phase: "ready" as "ready" | "hidden" | "restoring",
	});
	const [notices, setNotices] = useState<
		{ id: number; message: string; kind: FeedbackKind; origin?: string }[]
	>([]);
	const capture = useCallback(
		() =>
			document.current.phase === "ready" &&
			!router.options.context.authentication.getSnapshot().pending
				? document.current.controller.signal
				: null,
		[router],
	);
	useEffect(() => {
		if (document.current.controller.signal.aborted)
			document.current.controller = new AbortController();
		const retire = (reason: "identity" | "document") => {
			document.current.controller.abort(reason);
			document.current.controller = new AbortController();
			setNotices([]);
		};
		const hide = () => {
			document.current.phase = "hidden";
			retire("document");
		};
		const show = (event: PageTransitionEvent) => {
			if (!event.persisted) return;
			document.current.phase = "restoring";
			const signal = document.current.controller.signal;
			void router
				.invalidate({ sync: true })
				.then(() => {
					if (!signal.aborted && !mutationRefreshFailed(router))
						document.current.phase = "ready";
				})
				.catch(() => {});
		};
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		const stop = router.subscribe("onBeforeNavigate", ({ toLocation }) =>
			setNotices((previous) =>
				previous.filter(
					(notice) => !notice.origin || notice.origin === toLocation.href,
				),
			),
		);
		const authentication = router.options.context.authentication;
		let revision = authentication.getSnapshot().revision;
		const currentActor = () =>
			router.state.matches.flatMap((match) =>
				"user" in match.context ? [match.context.user.id] : [],
			)[0];
		let actor: string | undefined = currentActor();
		const clearIdentity = () => {
			retire("identity");
			router.options.context.queryClient.clear();
		};
		const broadcast = getGlobalBroadcastChannel();
		const stopBroadcast = broadcast.setup();
		let queuedIdentityRefresh = false;
		let disposed = false;
		const unsubscribeBroadcast = broadcast.subscribe(() => {
			if (queuedIdentityRefresh) return;
			clearIdentity();
			actor = undefined;
			router.clearCache();
			if (document.current.phase === "hidden") return;
			document.current.phase = "restoring";
			queuedIdentityRefresh = true;
			// Better Auth can also own a storage listener while its session hook is mounted.
			queueMicrotask(() => {
				queuedIdentityRefresh = false;
				if (!disposed) void router.invalidate({ sync: true }).catch(() => {});
			});
		});
		const unsubscribe = authentication.subscribe(() => {
			if (
				authentication.getSnapshot().pending ||
				authentication.getSnapshot().revision !== revision
			) {
				retire("identity");
				actor = undefined;
			}
			revision = authentication.getSnapshot().revision;
		});
		const resolved = router.subscribe("onResolved", () => {
			const current = currentActor();
			if (actor !== undefined && current !== undefined && current !== actor)
				clearIdentity();
			actor = current ?? actor;
			if (
				document.current.phase === "restoring" &&
				!mutationRefreshFailed(router)
			)
				document.current.phase = "ready";
		});
		return () => {
			disposed = true;
			unsubscribeBroadcast();
			stopBroadcast();
			stop();
			unsubscribe();
			resolved();
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", show);
			document.current.controller.abort("document");
		};
	}, [router]);
	useLocaleChangeBlocker(notices.length > 0);
	// Notices render as toasts; the state stays authoritative so updates and
	// navigation-scoped clearing keep working.
	const shown = useRef(new Set<number>());
	useEffect(() => {
		const current = new Set(notices.map((notice) => notice.id));
		for (const id of shown.current)
			if (!current.has(id)) toast.dismiss(`notice-${id}`);
		for (const notice of notices) {
			const forget = () =>
				setNotices((previous) =>
					previous.filter((entry) => entry.id !== notice.id),
				);
			// Acknowledgements stay until dismissed, like the banner they replace.
			toast.custom(
				() => (
					<NoticeToast
						kind={notice.kind}
						message={notice.message}
						onDismiss={forget}
					/>
				),
				{ id: `notice-${notice.id}`, duration: Number.POSITIVE_INFINITY },
			);
		}
		shown.current = current;
	}, [notices]);
	function setMessage(message: string | null, kind: FeedbackKind = "success") {
		setNotices(message ? [{ id: ++nextId.current, message, kind }] : []);
	}
	function publish(message: string, transient = false): MutationNotice {
		const id = ++nextId.current;
		setNotices((previous) => [
			...previous,
			{
				id,
				message,
				kind: "success",
				origin: transient ? router.state.location.href : undefined,
			},
		]);
		return {
			// Updating a dismissed notice must not bring it back.
			update: (message, kind = "warning") =>
				setNotices((previous) =>
					previous.map((notice) =>
						notice.id === id ? { ...notice, message, kind } : notice,
					),
				),
			clear: () =>
				setNotices((previous) => previous.filter((notice) => notice.id !== id)),
		};
	}
	return (
		<FeedbackContext
			value={{
				setMessage,
				publish,
				capture,
			}}
		>
			{children}
			<Toaster position="bottom-right" />
		</FeedbackContext>
	);
}

export function useMutationFeedback() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.setMessage;
}

export function useOptionalMutationFeedback() {
	return useContext(FeedbackContext)?.setMessage;
}

export function useMutationNotice() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation feedback requires the document shell");
	return feedback.publish;
}

export function useMutationBoundary() {
	const feedback = useContext(FeedbackContext);
	if (!feedback)
		throw new Error("Mutation ownership requires the document shell");
	return feedback.capture;
}
